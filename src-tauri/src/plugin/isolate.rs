//! FR-17..FR-24 — the QuickJS isolate every plugin invocation runs in.
//!
//! One runtime + one context per invocation, destroyed when it settles. Nothing
//! survives between invocations except `francois.storage`, which is a file.
//!
//! **The JS↔Rust boundary is JSON, deliberately.** Every host call marshals its
//! arguments with `JSON.stringify` and its result with `JSON.parse`. That costs a
//! little speed and buys three things worth more: the core never walks a
//! plugin-controlled object graph (no prototype tricks, no getters that run code
//! mid-traversal, no cycles), every argument arrives as a `serde_json::Value` the
//! existing validators already understand (FR-33), and the set of types that can
//! cross is closed by construction.
//!
//! **Host calls are synchronous on this thread**, then wrapped into a resolved
//! Promise by the prelude. That is what makes FR-20's "pause the CPU deadline
//! while awaiting I/O" expressible at all: there is no scheduler to ask, just an
//! interval this thread spent inside a blocking call, which we add back to the
//! deadline. The alternative — a futures runtime inside the isolate — would make
//! "CPU time" unobservable.

use super::*;

use rquickjs::context::intrinsic;
use rquickjs::{CatchResultExt, Context, Ctx, Function, Module, Runtime, Value as JsValue};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex as StdMutex};
use std::time::Instant;

/// FR-20's messages. Each names the limit that tripped, because "the plugin
/// failed" is not something a plugin author can act on.
pub(crate) const MSG_CPU: &str = "execution deadline exceeded";
pub(crate) const MSG_WALL: &str = "invocation deadline exceeded";
pub(crate) const MSG_MEMORY: &str = "memory limit exceeded";
pub(crate) const MSG_IO_CALLS: &str = "too many host calls";
pub(crate) const MSG_FETCHES: &str = "too many fetches in one invocation";
/// §7 #11/#12.
pub(crate) const MSG_IMPORTS: &str = "imports are not supported — bundle your plugin into one file";
pub(crate) const MSG_NO_DEFAULT: &str = "entry must export default an object";

/// Which entry point an invocation targets.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Handler {
    Panel,
    StatusBar,
    Command(String),
}

impl Handler {
    fn kind(&self) -> &'static str {
        match self {
            Handler::Panel => "panel",
            Handler::StatusBar => "statusBar",
            Handler::Command(_) => "command",
        }
    }
    fn command_id(&self) -> &str {
        match self {
            Handler::Command(id) => id,
            _ => "",
        }
    }
}

/// Everything an invocation needs, gathered BEFORE the registry lock is released
/// so the isolate never touches shared state itself (FR-22).
pub(crate) struct Invocation {
    pub plugin_id: String,
    pub plugin_version: String,
    pub entry_source: String,
    pub handler: Handler,
    /// The `PluginRenderContext` / `PluginCommandContext` object, already built.
    pub context: Value,
    /// FR-28: resolved settings, secrets in plaintext.
    pub settings: Map<String, Value>,
    pub capabilities: PluginCapabilities,
}

pub(crate) struct Outcome {
    /// The handler's return value, or `Value::Null` when it returned nothing
    /// (FR-43 — the surface clears without recording an error).
    pub value: Value,
    /// FR-26: whatever `francois.log` collected, for the ring buffer.
    pub logs: Vec<String>,
}

/// The capability-gated side of the world. `hostapi.rs` implements this; the
/// isolate deliberately knows nothing about `AppHandle`, sessions or the registry.
pub(crate) trait Host: Send + Sync {
    fn call(&self, method: &str, args: &[Value]) -> Result<Value, String>;
}

/// FR-20: the methods that count against the 8-I/O budget. Read-state calls are
/// served from memory and are not metered, matching the spec's parenthetical
/// ("`fetch` + `storage.*`") — but they DO pause the CPU deadline like any other
/// blocking host call, because the plugin is not burning CPU while they run.
fn is_metered_io(method: &str) -> bool {
    method == "fetch" || method.starts_with("storage.")
}

// ============================================================================
// FR-20 — the limits
// ============================================================================

/// Shared between the interrupt handler (owned by the runtime) and the host
/// closures (owned by the context). Both run on this one thread, so the atomics
/// are for ownership, not contention.
struct Guard {
    /// Epoch-ms at which the CPU budget expires. PUSHED FORWARD by the duration
    /// of each blocking host call (FR-20).
    cpu_deadline: AtomicU64,
    wall_deadline: u64,
    io_calls: AtomicU32,
    fetch_calls: AtomicU32,
    /// Set by whichever limit tripped first, so the error names the real cause
    /// rather than whatever QuickJS reported downstream.
    tripped: StdMutex<Option<&'static str>>,
}

impl Guard {
    fn new(now: u64) -> Self {
        Guard {
            cpu_deadline: AtomicU64::new(now + ISOLATE_CPU_DEADLINE_MS),
            wall_deadline: now + ISOLATE_WALL_DEADLINE_MS,
            io_calls: AtomicU32::new(0),
            fetch_calls: AtomicU32::new(0),
            tripped: StdMutex::new(None),
        }
    }

    fn trip(&self, reason: &'static str) {
        let mut slot = self.tripped.lock().unwrap();
        if slot.is_none() {
            *slot = Some(reason);
        }
    }

    fn reason(&self) -> Option<&'static str> {
        *self.tripped.lock().unwrap()
    }

    /// The interrupt handler QuickJS polls. `true` stops execution.
    fn should_interrupt(&self) -> bool {
        let now = now_ms();
        if now > self.wall_deadline {
            self.trip(MSG_WALL);
            return true;
        }
        if now > self.cpu_deadline.load(Ordering::Relaxed) {
            self.trip(MSG_CPU);
            return true;
        }
        false
    }

    /// FR-20: has the whole-invocation clock run out? Trips the guard as a side
    /// effect so a plugin cannot swallow the refusal and report success.
    fn wall_expired(&self) -> bool {
        if now_ms() > self.wall_deadline {
            self.trip(MSG_WALL);
            return true;
        }
        false
    }

    /// FR-20: give back the time spent blocked in a host call, so a slow network
    /// never reads as a runaway loop. The wall-clock deadline is NOT extended —
    /// that one exists precisely to bound total time including I/O.
    fn credit_io(&self, elapsed_ms: u64) {
        self.cpu_deadline.fetch_add(elapsed_ms, Ordering::Relaxed);
    }

    fn charge_call(&self, method: &str) -> Result<(), &'static str> {
        if !is_metered_io(method) {
            return Ok(());
        }
        if self.io_calls.fetch_add(1, Ordering::Relaxed) + 1 > ISOLATE_MAX_IO_CALLS {
            return Err(MSG_IO_CALLS);
        }
        if method == "fetch"
            && self.fetch_calls.fetch_add(1, Ordering::Relaxed) + 1 > FETCH_MAX_PER_INVOCATION
        {
            return Err(MSG_FETCHES);
        }
        Ok(())
    }
}

// ============================================================================
// FR-19 — the module resolver that says no
// ============================================================================

/// A v1 plugin is one self-contained file. Rejecting at RESOLVE time (rather
/// than failing to load) is what produces §7 #11's actionable message instead of
/// a bare "module not found".
struct NoImports;

impl rquickjs::loader::Resolver for NoImports {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        _base: &str,
        _name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<String> {
        Err(rquickjs::Error::new_resolving_message("", "", MSG_IMPORTS))
    }
}

struct NoLoader;

impl rquickjs::loader::Loader for NoLoader {
    fn load<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<rquickjs::loader::ImportAttributes<'js>>,
    ) -> rquickjs::Result<Module<'js, rquickjs::module::Declared>> {
        Err(rquickjs::Error::new_loading_message(name, MSG_IMPORTS))
    }
}

// ============================================================================
// The prelude
// ============================================================================

/// Builds `francois` from the four temporaries the core injected, then removes
/// them so the plugin cannot reach the unwrapped natives.
///
/// The wrapping is the FR-32 contract: a host function REJECTS, it never throws
/// synchronously, so `francois.fetch(...).catch(...)` always works and a plugin
/// can never take the invocation down by forgetting a try/catch around a call.
const PRELUDE: &str = r#"
(function () {
  // FR-18: remove the JS-visible codegen entry points. Deleting the globals is
  // only half of it — every function still reaches its constructor through the
  // prototype, so `(function(){}).constructor('...')()` would revive `Function`
  // (and the async/generator variants have their own). Neuter all four.
  for (const sample of [function () {}, async function () {}, function* () {}, async function* () {}]) {
    const proto = Object.getPrototypeOf(sample);
    try {
      Object.defineProperty(proto, 'constructor', {
        value: undefined, writable: false, enumerable: false, configurable: false,
      });
    } catch (e) {}
  }
  delete globalThis.eval;
  delete globalThis.Function;
  // FR-18 names these as absent; QuickJS ships them with the intrinsics above.
  delete globalThis.SharedArrayBuffer;
  delete globalThis.Reflect;

  // FR-18 lists TextEncoder/TextDecoder in the starting set, but they are web
  // APIs rather than QuickJS intrinsics, so the core supplies them. UTF-8 only,
  // which is the whole of what the spec's set implies.
  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input) {
      const s = String(input === undefined ? '' : input);
      const out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.codePointAt(i);
        if (c > 0xffff) i++;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
  };
  globalThis.TextDecoder = class TextDecoder {
    get encoding() { return 'utf-8'; }
    decode(input) {
      if (input === undefined) return '';
      const b = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input);
      let out = '';
      for (let i = 0; i < b.length; ) {
        const c = b[i];
        let point, len;
        if (c < 0x80) { point = c; len = 1; }
        else if ((c & 0xe0) === 0xc0) { point = c & 31; len = 2; }
        else if ((c & 0xf0) === 0xe0) { point = c & 15; len = 3; }
        else if ((c & 0xf8) === 0xf0) { point = c & 7; len = 4; }
        else { out += '�'; i++; continue; }
        if (i + len > b.length) { out += '�'; break; }
        for (let k = 1; k < len; k++) point = (point << 6) | (b[i + k] & 63);
        out += String.fromCodePoint(point);
        i += len;
      }
      return out;
    }
  };

  const host = globalThis.__host;
  const caps = globalThis.__caps;
  const plugin = globalThis.__plugin;
  const settings = globalThis.__settings;
  delete globalThis.__host;
  delete globalThis.__caps;
  delete globalThis.__plugin;
  delete globalThis.__settings;

  // Every host call: stringify in, parse out. Synchronous under the hood,
  // presented as a promise (FR-32).
  const call = (method) => function () {
    const args = Array.prototype.slice.call(arguments);
    try {
      const raw = host(method, JSON.stringify(args));
      return Promise.resolve(raw === undefined || raw === null ? null : JSON.parse(raw));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };
  const sync = (method) => function () {
    const args = Array.prototype.slice.call(arguments);
    const raw = host(method, JSON.stringify(args));
    return raw === undefined || raw === null ? null : JSON.parse(raw);
  };

  const freeze = (o) => Object.freeze(o);
  const api = {
    plugin: freeze({ id: plugin.id, version: plugin.version }),
    // log is fire-and-forget and never throws — a logging call that could fail
    // would be a trap in every catch block a plugin writes.
    log: function () {
      try { host('log', JSON.stringify(Array.prototype.slice.call(arguments))); } catch (e) {}
    },
    settings: freeze({ get: function () { return JSON.parse(settings); } }),
    storage: freeze({
      get: call('storage.get'),
      set: call('storage.set'),
      remove: call('storage.remove'),
      keys: call('storage.keys'),
    }),
  };

  // FR-9: a capability that was not granted is ABSENT, never a throwing stub —
  // so `typeof francois.fetch === 'function'` is a truthful feature test.
  if (caps.readState) {
    api.sessions = freeze({ list: call('sessions.list'), get: call('sessions.get') });
    api.agents = freeze({ list: call('agents.list') });
    api.diff = freeze({ summary: call('diff.summary') });
    api.projects = freeze({ list: call('projects.list'), current: call('projects.current') });
    api.usage = freeze({ get: call('usage.get') });
  }
  if (caps.driveSessions) {
    api.session = freeze({ prompt: call('session.prompt') });
  }
  if (caps.network) {
    api.fetch = call('fetch');
  }
  globalThis.francois = freeze(api);
  void sync;

  // The bridge the core calls once the module has evaluated.
  globalThis.__run = function (mod, kind, commandId, ctxJson) {
    return (async function () {
      if (!mod || typeof mod !== 'object') throw new Error(__NO_DEFAULT__);
      const ctx = JSON.parse(ctxJson);
      let out;
      if (kind === 'panel') {
        if (typeof mod.panel !== 'function') throw new Error('plugin declares a panel but exports none');
        out = mod.panel(ctx);
      } else if (kind === 'statusBar') {
        if (typeof mod.statusBar !== 'function') throw new Error('plugin declares a status item but exports none');
        out = mod.statusBar(ctx);
      } else {
        const fn = mod.commands && mod.commands[commandId];
        if (typeof fn !== 'function') throw new Error('the plugin does not implement this command');
        out = fn(ctx);
      }
      const value = await out;
      return value === undefined || value === null ? null : JSON.stringify(value);
    })();
  };
})();
"#;

// ============================================================================
// FR-17..FR-24 — running one invocation
// ============================================================================

/// Run one invocation to completion on the CALLING thread. The caller is
/// responsible for making that a blocking worker, never the UI or command
/// thread (FR-22).
///
/// FR-24: a panic anywhere inside — including in a host closure — is caught here
/// and becomes an ordinary error. A plugin must never be able to abort Francois.
pub(crate) fn run(inv: &Invocation, host: Arc<dyn Host>) -> Result<Outcome, String> {
    let logs = Arc::new(StdMutex::new(Vec::<String>::new()));
    let collected = Arc::clone(&logs);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run_inner(inv, host, &collected)
    }));
    let logs = std::mem::take(&mut *logs.lock().unwrap());
    match result {
        Ok(Ok(value)) => Ok(Outcome { value, logs }),
        Ok(Err(msg)) => Err(msg),
        Err(_) => Err("the plugin crashed the isolate".into()),
    }
}

fn run_inner(
    inv: &Invocation,
    host: Arc<dyn Host>,
    logs: &Arc<StdMutex<Vec<String>>>,
) -> Result<Value, String> {
    let guard = Arc::new(Guard::new(now_ms()));

    let runtime = Runtime::new().map_err(|e| format!("could not start the isolate: {e}"))?;
    // FR-20: memory and stack first, so even the prelude runs under them.
    runtime.set_memory_limit(ISOLATE_MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(ISOLATE_MAX_STACK_BYTES);
    runtime.set_loader(NoImports, NoLoader); // FR-19
    let interrupt = Arc::clone(&guard);
    runtime.set_interrupt_handler(Some(Box::new(move || interrupt.should_interrupt())));

    // FR-18: the intrinsics the spec names, and nothing else. `Proxy`, `WeakRef`
    // and `Performance` are absent.
    //
    // `Eval` is present, and has to be: QuickJS routes ALL source compilation
    // through the eval intrinsic, module bodies included, so without it not even
    // the plugin's entry file could be loaded. The prelude therefore removes the
    // JS-visible codegen entry points itself (`eval`, `Function`, and the
    // `.constructor` back doors) so FR-18's list holds from the plugin's side.
    //
    // Worth being precise about what that buys: dynamic codegen is not itself a
    // sandbox escape — the plugin is already arbitrary JavaScript. The boundary
    // is the absence of host functions, and `eval` cannot conjure one. What FR-19
    // actually protects is pulling in code from OUTSIDE the file, and that is the
    // import resolver's job.
    let context = Context::custom::<(
        intrinsic::Eval,
        intrinsic::Date,
        intrinsic::RegExp,
        intrinsic::RegExpCompiler,
        intrinsic::Json,
        intrinsic::MapSet,
        intrinsic::TypedArrays,
        intrinsic::Promise,
    )>(&runtime)
    .map_err(|e| format!("could not start the isolate: {e}"))?;

    let outcome = context.with(|ctx| -> Result<Value, String> {
        install_globals(&ctx, inv, host, &guard, logs)?;
        // The prelude is evaluated as a MODULE, not with `ctx.eval`. `eval` is a
        // capability of the Eval intrinsic, which FR-18 excludes precisely so a
        // plugin has no `eval`/`Function` — and the core must not need the thing
        // it denies the plugin. Module evaluation is a separate engine entry point.
        Module::evaluate(
            ctx.clone(),
            "francois:prelude",
            PRELUDE.replace("__NO_DEFAULT__", &format!("{MSG_NO_DEFAULT:?}")),
        )
        .catch(&ctx)
        .map_err(|e| describe(&guard, &e.to_string()))?
        .finish::<()>()
        .catch(&ctx)
        .map_err(|e| describe(&guard, &e.to_string()))?;

        // FR-19: evaluate the entry as an ES MODULE and take its default export.
        let (module, promise) = Module::declare(ctx.clone(), "plugin", inv.entry_source.as_str())
            .catch(&ctx)
            .map_err(|e| describe(&guard, &e.to_string()))?
            .eval()
            .catch(&ctx)
            .map_err(|e| describe(&guard, &e.to_string()))?;
        promise
            .finish::<()>()
            .catch(&ctx)
            .map_err(|e| describe(&guard, &e.to_string()))?;

        let default: JsValue = module
            .get("default")
            .map_err(|_| MSG_NO_DEFAULT.to_string())?;
        if default.as_object().is_none() {
            return Err(MSG_NO_DEFAULT.into());
        }

        let run_fn: Function = ctx
            .globals()
            .get("__run")
            .map_err(|e| format!("could not start the isolate: {e}"))?;
        let ctx_json = serde_json::to_string(&inv.context).unwrap_or_else(|_| "{}".into());
        let pending: rquickjs::Promise = run_fn
            .call((
                default,
                inv.handler.kind(),
                inv.handler.command_id(),
                ctx_json,
            ))
            .catch(&ctx)
            .map_err(|e| describe(&guard, &e.to_string()))?;

        // FR-21: `finish` runs the microtask queue until the promise settles.
        // Every host call is synchronous, so the queue draining IS the completion
        // condition — nothing external can wake this. Whatever is still pending
        // when it settles dies with the isolate.
        //
        // `WouldBlock` means the queue emptied with the promise unresolved: a
        // plugin awaiting something that can never arrive. That is the deadline's
        // case, and the guard usually already named it.
        let settled = pending.finish::<Option<String>>().catch(&ctx);
        // A tripped guard is FINAL, even on an apparent success. A plugin that
        // wraps its host calls in try/catch would otherwise be able to swallow a
        // deadline refusal and return a spec as if nothing had happened — the
        // limits have to hold against a hostile plugin, not just a buggy one.
        if let Some(reason) = guard.reason() {
            return Err(reason.to_string());
        }
        match settled {
            Err(e) => Err(describe(&guard, &e.to_string())),
            Ok(None) => Ok(Value::Null),
            Ok(Some(json)) => serde_json::from_str(&json)
                .map_err(|_| "the handler returned a value that is not JSON".to_string()),
        }
    });

    outcome
}

/// Turn whatever QuickJS said into the message FR-20 promises. A tripped guard
/// always wins: the engine reports an interrupt as a generic exception, and
/// "InternalError: interrupted" is not something a plugin author can act on.
fn describe(guard: &Guard, raw: &str) -> String {
    if let Some(reason) = guard.reason() {
        return reason.to_string();
    }
    let lower = raw.to_lowercase();
    if lower.contains("out of memory") || lower.contains("allocation") {
        return MSG_MEMORY.to_string();
    }
    if lower.contains("interrupted") {
        return MSG_CPU.to_string();
    }
    if lower.contains("stack overflow") || lower.contains("maximum call stack") {
        return "maximum call stack size exceeded".to_string();
    }
    clean_text(strip_stack(raw), 400, false)
}

/// A caught exception renders as `Error: msg` followed by `    at frame` lines.
/// The frames name positions inside the PRELUDE as often as the plugin, so they
/// are noise in a pane that has four lines to work with — and they would make
/// every spec-mandated message ("entry must export default an object") fail to
/// match itself. `lastError.message` keeps the first line only.
fn strip_stack(raw: &str) -> &str {
    let head = raw.split("\n    at ").next().unwrap_or(raw);
    let head = head.split("    at ").next().unwrap_or(head);
    let head = head.lines().next().unwrap_or(head).trim();
    // `Error: x` and a bare `x` should read the same in the pane.
    head.strip_prefix("Error: ").unwrap_or(head).trim()
}

/// FR-25: install the four temporaries the prelude consumes. `__host` is the only
/// function; everything else is data.
fn install_globals(
    ctx: &Ctx<'_>,
    inv: &Invocation,
    host: Arc<dyn Host>,
    guard: &Arc<Guard>,
    logs: &Arc<StdMutex<Vec<String>>>,
) -> Result<(), String> {
    let globals = ctx.globals();

    let caps = ctx
        .json_parse(
            serde_json::json!({
                "readState": inv.capabilities.read_state(),
                "driveSessions": inv.capabilities.drive_sessions(),
                "network": inv.capabilities.has_network(),
            })
            .to_string(),
        )
        .map_err(|e| format!("could not start the isolate: {e}"))?;
    let plugin = ctx
        .json_parse(
            serde_json::json!({ "id": inv.plugin_id, "version": inv.plugin_version }).to_string(),
        )
        .map_err(|e| format!("could not start the isolate: {e}"))?;

    globals.set("__caps", caps).ok();
    globals.set("__plugin", plugin).ok();
    globals
        .set(
            "__settings",
            serde_json::to_string(&inv.settings).unwrap_or_else(|_| "{}".into()),
        )
        .ok();

    let call_guard = Arc::clone(guard);
    let call_logs = Arc::clone(logs);
    let plugin_id = inv.plugin_id.clone();
    let host_fn = Function::new(
        ctx.clone(),
        move |ctx: Ctx<'_>,
              method: String,
              args_json: String|
              -> rquickjs::Result<Option<String>> {
            match dispatch(
                &host,
                &call_guard,
                &call_logs,
                &plugin_id,
                &method,
                &args_json,
            ) {
                Ok(value) => Ok(value),
                // Throw a real JS Error so `instanceof Error` holds inside the
                // plugin and the prelude's rejection wrapper keeps the message.
                Err(msg) => Err(rquickjs::Exception::throw_message(&ctx, &msg)),
            }
        },
    )
    .map_err(|e| format!("could not start the isolate: {e}"))?;
    globals
        .set("__host", host_fn)
        .map_err(|e| format!("could not start the isolate: {e}"))?;
    Ok(())
}

/// One host call: meter it, run it with the CPU clock paused, marshal the result.
fn dispatch(
    host: &Arc<dyn Host>,
    guard: &Arc<Guard>,
    logs: &Arc<StdMutex<Vec<String>>>,
    plugin_id: &str,
    method: &str,
    args_json: &str,
) -> Result<Option<String>, String> {
    // FR-33: the arguments arrive as JSON and are parsed HERE. A plugin that
    // sends something unparseable gets an argument rejection, not a surprise
    // deeper in the core.
    let args: Vec<Value> = serde_json::from_str(args_json)
        .map_err(|_| "host call arguments must be JSON-serializable".to_string())?;

    if method == "log" {
        record_log(logs, plugin_id, &args);
        return Ok(None);
    }

    // FR-20: the interrupt handler is only polled while JS is EXECUTING, so a
    // plugin that spends its whole invocation blocked in host calls would never
    // be interrupted. Check the wall clock here too — this is the one place the
    // engine cannot check for us.
    if guard.wall_expired() {
        return Err(MSG_WALL.to_string());
    }
    guard.charge_call(method).map_err(String::from)?;
    let started = Instant::now();
    let result = host.call(method, &args);
    guard.credit_io(started.elapsed().as_millis() as u64);
    if guard.wall_expired() {
        return Err(MSG_WALL.to_string());
    }

    match result? {
        Value::Null => Ok(None),
        value => Ok(Some(serde_json::to_string(&value).map_err(|_| {
            "the host returned a value that is not JSON".to_string()
        })?)),
    }
}

/// FR-26: JSON-stringify each argument (cycles → `[circular]`), join with a
/// space, truncate, and push onto the ring.
fn record_log(logs: &Arc<StdMutex<Vec<String>>>, plugin_id: &str, args: &[Value]) {
    let line = args
        .iter()
        .map(|v| match v {
            // A bare string logs as itself — quoting every log line would make
            // the log view unreadable for the common case.
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut buf = logs.lock().unwrap();
    if buf.len() < LOG_RING_MAX_LINES {
        buf.push(clean_text(&line, LOG_MAX_LINE_CHARS, false));
    }
    let _ = plugin_id;
}

// ============================================================================
// FR-22 — the pool
// ============================================================================

/// At most `ISOLATE_MAX_CONCURRENT` isolates across all plugins, and at most one
/// in flight per plugin.
///
/// The per-plugin rule is a DROP, not a queue (FR-22 / §7 #24): a refresh tick
/// that arrives while the previous one is still running is discarded silently.
/// Queueing would let a slow plugin build an unbounded backlog of stale renders.
#[derive(Default)]
pub(crate) struct IsolatePool {
    state: StdMutex<PoolState>,
    slot_freed: Condvar,
}

#[derive(Default)]
struct PoolState {
    running: usize,
    in_flight: std::collections::HashSet<String>,
}

pub(crate) struct PoolGuard<'a> {
    pool: &'a IsolatePool,
    plugin_id: String,
}

impl Drop for PoolGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.pool.state.lock().unwrap();
        state.running -= 1;
        state.in_flight.remove(&self.plugin_id);
        drop(state);
        self.pool.slot_freed.notify_one();
    }
}

impl IsolatePool {
    /// `None` ⇒ this plugin already has an invocation in flight; the caller drops
    /// the tick. Otherwise blocks until a global slot frees.
    pub(crate) fn acquire(&self, plugin_id: &str) -> Option<PoolGuard<'_>> {
        let mut state = self.state.lock().unwrap();
        if state.in_flight.contains(plugin_id) {
            return None;
        }
        while state.running >= ISOLATE_MAX_CONCURRENT {
            state = self.slot_freed.wait(state).unwrap();
            // Re-check: another waiter for the SAME plugin may have started while
            // we were parked.
            if state.in_flight.contains(plugin_id) {
                return None;
            }
        }
        state.running += 1;
        state.in_flight.insert(plugin_id.to_string());
        Some(PoolGuard {
            pool: self,
            plugin_id: plugin_id.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A host that records what it was asked and answers from a fixed table.
    struct FakeHost {
        answers: std::collections::HashMap<String, Value>,
        calls: StdMutex<Vec<(String, Vec<Value>)>>,
        /// Milliseconds each call blocks for, to exercise the FR-20 pause.
        delay_ms: u64,
    }

    impl FakeHost {
        fn new(answers: &[(&str, Value)]) -> Arc<Self> {
            Arc::new(FakeHost {
                answers: answers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
                calls: StdMutex::new(Vec::new()),
                delay_ms: 0,
            })
        }
    }

    impl Host for FakeHost {
        fn call(&self, method: &str, args: &[Value]) -> Result<Value, String> {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), args.to_vec()));
            if self.delay_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(self.delay_ms));
            }
            match self.answers.get(method) {
                Some(v) => Ok(v.clone()),
                None => Err(format!("no such host method: {method}")),
            }
        }
    }

    fn invoke(
        source: &str,
        caps: PluginCapabilities,
        host: Arc<dyn Host>,
    ) -> Result<Value, String> {
        run(
            &Invocation {
                plugin_id: "acme-ci".into(),
                plugin_version: "1.0.0".into(),
                entry_source: source.into(),
                handler: Handler::Panel,
                context: json!({ "surface": "panel", "projectId": null, "sessionId": null, "now": 1 }),
                settings: Map::new(),
                capabilities: caps,
            },
            host,
        )
        .map(|o| o.value)
    }

    fn panel(source: &str) -> Result<Value, String> {
        invoke(source, PluginCapabilities::default(), FakeHost::new(&[]))
    }

    // ---------- FR-19: the module contract ----------

    #[test]
    fn a_default_exported_panel_runs_and_its_value_comes_back_as_json() {
        let v = panel(
            "export default { panel(ctx) { return { version: 1, nodes: [{ type: 'text', value: 'hi ' + ctx.surface }] } } }",
        )
        .unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["nodes"][0]["value"], "hi panel");
    }

    #[test]
    fn an_async_handler_is_driven_to_completion() {
        // FR-21: the core drives the returned promise until it settles.
        let v = panel(
            "export default { async panel() { await Promise.resolve(); return { version: 1, nodes: [] } } }",
        )
        .unwrap();
        assert_eq!(v["version"], 1);
    }

    #[test]
    fn returning_nothing_clears_the_surface_without_an_error() {
        // FR-43.
        for source in [
            "export default { panel() {} }",
            "export default { panel() { return null } }",
            "export default { async panel() { return undefined } }",
        ] {
            assert_eq!(panel(source).unwrap(), Value::Null, "{source}");
        }
    }

    #[test]
    fn a_missing_or_non_object_default_export_fails_with_the_spec_message() {
        // §7 #12.
        for source in [
            "export const panel = () => null",
            "export default 42",
            "export default 'nope'",
            "export default function () {}",
        ] {
            let e = panel(source).unwrap_err();
            assert_eq!(e, MSG_NO_DEFAULT, "{source}");
        }
    }

    #[test]
    fn a_syntax_error_reports_the_engine_message() {
        // §7 #10: the author needs the line, so the raw message is passed through.
        let e = panel("export default { panel() { return ( } }").unwrap_err();
        assert!(!e.is_empty() && e != MSG_NO_DEFAULT, "{e}");
    }

    #[test]
    fn every_import_specifier_is_rejected_with_an_actionable_message() {
        // §7 #11 / FR-19.
        for source in [
            "import 'node-fetch'; export default { panel() { return null } }",
            "import fs from 'fs'; export default { panel() { return null } }",
            "export default { panel() { return null } }; export * from './other.js';",
        ] {
            let e = panel(source).unwrap_err();
            assert!(e.contains("bundle your plugin"), "{source} → {e}");
        }
    }

    #[test]
    fn a_declared_surface_with_no_export_says_so() {
        // FR-44.
        let e = panel("export default { statusBar() { return null } }").unwrap_err();
        assert!(e.contains("declares a panel but exports none"), "{e}");
    }

    // ---------- FR-18: the empty global ----------

    #[test]
    fn the_intrinsics_fr_18_names_are_present() {
        let v = panel(
            r#"export default { panel() {
                const names = ['Object','Array','JSON','Math','String','Number','Date','Promise','RegExp',
                               'Map','Set','Error','Uint8Array','ArrayBuffer','TextEncoder','TextDecoder'];
                return { version: 1, nodes: names
                    .filter(n => typeof globalThis[n] === 'undefined')
                    .map(n => ({ type: 'text', value: n })) };
            } }"#,
        )
        .unwrap();
        assert_eq!(
            v["nodes"].as_array().unwrap().len(),
            0,
            "these intrinsics must exist: {:?}",
            v["nodes"]
        );
    }

    #[test]
    fn the_supplied_text_codecs_round_trip_utf8() {
        // The shim is ours, so it needs its own proof.
        let v = panel(
            r#"export default { panel() {
                const enc = new TextEncoder(), dec = new TextDecoder();
                const samples = ['', 'ascii', 'héllo', '🌍 ok', '日本語', 'mixed é🌍 x'];
                return { version: 1, nodes: samples
                    .filter(s => dec.decode(enc.encode(s)) !== s)
                    .map(s => ({ type: 'text', value: s })) };
            } }"#,
        )
        .unwrap();
        assert_eq!(
            v["nodes"].as_array().unwrap().len(),
            0,
            "failed: {:?}",
            v["nodes"]
        );
    }

    #[test]
    fn every_host_dom_and_node_global_is_absent() {
        // FR-18: the whole point. `francois.log` is the only output channel.
        let v = panel(
            r#"export default { panel() {
                const names = ['fetch','console','require','process','Buffer','setTimeout','setInterval',
                               'eval','Function','WebAssembly','SharedArrayBuffer','window','document',
                               '__host','__caps','__plugin','__settings','__import','Proxy','Reflect'];
                return { version: 1, nodes: names
                    .filter(n => typeof globalThis[n] !== 'undefined')
                    .map(n => ({ type: 'text', value: n })) };
            } }"#,
        )
        .unwrap();
        assert_eq!(
            v["nodes"].as_array().unwrap().len(),
            0,
            "these globals must not exist: {:?}",
            v["nodes"]
        );
    }

    #[test]
    fn the_francois_object_is_frozen_and_cannot_be_reshaped() {
        // FR-25: deep-frozen. A plugin that could replace `francois.fetch` could
        // hand a doctored one to a second plugin's code it somehow loaded.
        let v = panel(
            r#"export default { panel() {
                const before = francois.plugin.id;
                try { francois.fetch = () => {}; } catch (e) {}
                try { francois.plugin.id = 'other'; } catch (e) {}
                try { francois.storage.get = () => {}; } catch (e) {}
                return { version: 1, nodes: [
                  { type: 'text', value: 'id:' + francois.plugin.id + ':' + before },
                  { type: 'text', value: 'frozen:' + Object.isFrozen(francois) },
                  { type: 'text', value: 'fetch:' + (typeof francois.fetch) },
                ] };
            } }"#,
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["value"], "id:acme-ci:acme-ci");
        assert_eq!(v["nodes"][1]["value"], "frozen:true");
        assert_eq!(v["nodes"][2]["value"], "fetch:undefined");
    }

    // ---------- FR-9: capability gating ----------

    #[test]
    fn an_ungranted_capability_is_absent_rather_than_a_throwing_stub() {
        // §7 #18: `TypeError: francois.fetch is not a function`.
        let v = panel(
            r#"export default { panel() {
                return { version: 1, nodes: [
                  { type: 'text', value: 'fetch:' + (typeof francois.fetch) },
                  { type: 'text', value: 'sessions:' + (typeof francois.sessions) },
                  { type: 'text', value: 'session:' + (typeof francois.session) },
                  { type: 'text', value: 'storage:' + (typeof francois.storage.get) },
                ] };
            } }"#,
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["value"], "fetch:undefined");
        assert_eq!(v["nodes"][1]["value"], "sessions:undefined");
        assert_eq!(v["nodes"][2]["value"], "session:undefined");
        assert_eq!(v["nodes"][3]["value"], "storage:function", "always present");
    }

    #[test]
    fn granted_capabilities_appear() {
        let caps = PluginCapabilities {
            read_state: Some(true),
            drive_sessions: Some(true),
            network: Some(PluginNetwork {
                hosts: vec!["acme.dev".into()],
            }),
        };
        let v = invoke(
            r#"export default { panel() {
                return { version: 1, nodes: [
                  { type: 'text', value: 'fetch:' + (typeof francois.fetch) },
                  { type: 'text', value: 'sessions:' + (typeof francois.sessions.list) },
                  { type: 'text', value: 'agents:' + (typeof francois.agents.list) },
                  { type: 'text', value: 'diff:' + (typeof francois.diff.summary) },
                  { type: 'text', value: 'projects:' + (typeof francois.projects.current) },
                  { type: 'text', value: 'usage:' + (typeof francois.usage.get) },
                  { type: 'text', value: 'prompt:' + (typeof francois.session.prompt) },
                ] };
            } }"#,
            caps,
            FakeHost::new(&[]),
        )
        .unwrap();
        for node in v["nodes"].as_array().unwrap() {
            let s = node["value"].as_str().unwrap();
            assert!(s.ends_with(":function"), "missing member: {s}");
        }
    }

    // ---------- FR-32: host call semantics ----------

    #[test]
    fn a_host_call_marshals_arguments_and_results_as_json() {
        let host = FakeHost::new(&[("storage.get", json!({ "runs": [1, 2] }))]);
        let v = invoke(
            r#"export default { async panel() {
                const got = await francois.storage.get('runs');
                return { version: 1, nodes: [{ type: 'text', value: JSON.stringify(got) }] };
            } }"#,
            PluginCapabilities::default(),
            host.clone(),
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["value"], r#"{"runs":[1,2]}"#);
        let calls = host.calls.lock().unwrap();
        assert_eq!(calls[0].0, "storage.get");
        assert_eq!(calls[0].1, vec![json!("runs")]);
    }

    #[test]
    fn a_host_refusal_rejects_the_promise_and_never_throws_synchronously() {
        // FR-32: `francois.fetch(...).catch(...)` must always work.
        let v = invoke(
            r#"export default { async panel() {
                let sync = 'no';
                let caught = 'no';
                try { const p = francois.storage.get('k'); sync = 'ok'; await p; }
                catch (e) { caught = e.message; }
                return { version: 1, nodes: [
                  { type: 'text', value: 'sync:' + sync },
                  { type: 'text', value: 'caught:' + caught },
                ] };
            } }"#,
            PluginCapabilities::default(),
            FakeHost::new(&[]), // every method errors
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["value"], "sync:ok", "no synchronous throw");
        assert!(
            v["nodes"][1]["value"]
                .as_str()
                .unwrap()
                .contains("no such host method"),
            "{:?}",
            v["nodes"][1]
        );
    }

    #[test]
    fn an_unhandled_rejection_escaping_the_handler_fails_the_invocation() {
        // FR-32's other half: the plugin's own unhandled error is its problem.
        let e = invoke(
            "export default { async panel() { await francois.storage.get('k'); return null } }",
            PluginCapabilities::default(),
            FakeHost::new(&[]),
        )
        .unwrap_err();
        assert!(e.contains("no such host method"), "{e}");
    }

    #[test]
    fn logs_are_collected_stringified_and_bounded() {
        // FR-26.
        let out = run(
            &Invocation {
                plugin_id: "acme-ci".into(),
                plugin_version: "1.0.0".into(),
                entry_source: r#"export default { panel() {
                    francois.log('hello', 42, { a: 1 }, [1,2], true, null);
                    francois.log('x'.repeat(5000));
                    for (let i = 0; i < 500; i++) francois.log('line' + i);
                    return null;
                } }"#
                    .into(),
                handler: Handler::Panel,
                context: json!({}),
                settings: Map::new(),
                capabilities: PluginCapabilities::default(),
            },
            FakeHost::new(&[]),
        )
        .unwrap();
        assert_eq!(out.logs[0], r#"hello 42 {"a":1} [1,2] true null"#);
        assert_eq!(out.logs[1].chars().count(), LOG_MAX_LINE_CHARS);
        assert_eq!(
            out.logs.len(),
            LOG_RING_MAX_LINES,
            "FR-26: the ring is bounded"
        );
    }

    #[test]
    fn settings_reach_the_plugin_in_plaintext() {
        // FR-28.
        let mut settings = Map::new();
        settings.insert("token".into(), json!("ghp_real"));
        settings.insert("poll".into(), json!(30));
        let out = run(
            &Invocation {
                plugin_id: "acme-ci".into(),
                plugin_version: "1.0.0".into(),
                entry_source: r#"export default { panel() {
                    const s = francois.settings.get();
                    return { version: 1, nodes: [{ type: 'text', value: s.token + '/' + s.poll }] };
                } }"#
                    .into(),
                handler: Handler::Panel,
                context: json!({}),
                settings,
                capabilities: PluginCapabilities::default(),
            },
            FakeHost::new(&[]),
        )
        .unwrap();
        assert_eq!(out.value["nodes"][0]["value"], "ghp_real/30");
    }

    // ---------- FR-20: the limits ----------

    #[test]
    fn an_infinite_loop_trips_the_cpu_deadline() {
        // §7 #13. The isolate dies; the caller is unaffected.
        let started = Instant::now();
        let e = panel("export default { panel() { while (true) {} } }").unwrap_err();
        assert_eq!(e, MSG_CPU);
        assert!(
            started.elapsed().as_millis() < (ISOLATE_WALL_DEADLINE_MS + 2_000) as u128,
            "should trip on the CPU deadline, not the wall one"
        );
    }

    #[test]
    fn a_recursive_allocation_trips_a_limit_rather_than_taking_the_process_down() {
        // §7 #15. Whether the engine reports memory or the deadline first is not
        // the contract — that it STOPS, with a message, is.
        let e = panel("export default { panel() { const a = []; while (true) a.push(new Array(10000).fill('x')) } }")
            .unwrap_err();
        assert!(
            [MSG_MEMORY, MSG_CPU, MSG_WALL].contains(&e.as_str()),
            "unexpected: {e}"
        );
    }

    #[test]
    fn deep_recursion_is_caught_by_the_stack_limit() {
        let e =
            panel("export default { panel() { const f = () => f(); return f() } }").unwrap_err();
        assert!(!e.is_empty(), "a stack overflow must surface as an error");
    }

    #[test]
    fn the_io_call_budget_is_enforced() {
        // FR-20: at most 8 metered host calls per invocation.
        let host = FakeHost::new(&[("storage.get", json!("v"))]);
        let v = invoke(
            r#"export default { async panel() {
                let ok = 0, err = '';
                for (let i = 0; i < 12; i++) {
                  try { await francois.storage.get('k'); ok++; } catch (e) { err = e.message; break; }
                }
                return { version: 1, nodes: [{ type: 'text', value: ok + '/' + err }] };
            } }"#,
            PluginCapabilities::default(),
            host,
        )
        .unwrap();
        assert_eq!(
            v["nodes"][0]["value"],
            format!("{ISOLATE_MAX_IO_CALLS}/{MSG_IO_CALLS}")
        );
    }

    #[test]
    fn logging_is_not_metered_against_the_io_budget() {
        // FR-26: the log ring is in memory — metering it would make a debug line
        // cost a fetch.
        let host = FakeHost::new(&[("storage.get", json!("v"))]);
        let v = invoke(
            r#"export default { async panel() {
                for (let i = 0; i < 50; i++) francois.log('noise', i);
                await francois.storage.get('k');
                return { version: 1, nodes: [{ type: 'text', value: 'ok' }] };
            } }"#,
            PluginCapabilities::default(),
            host,
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["value"], "ok");
    }

    #[test]
    fn time_spent_blocked_in_a_host_call_does_not_burn_the_cpu_deadline() {
        // FR-20's pause. Four calls of 700 ms each is 2.8 s of wall time — well
        // past the 2 s CPU deadline — but none of it is the plugin computing.
        let host = Arc::new(FakeHost {
            answers: [("storage.get".to_string(), json!("v"))]
                .into_iter()
                .collect(),
            calls: StdMutex::new(Vec::new()),
            delay_ms: 700,
        });
        let v = invoke(
            r#"export default { async panel() {
                for (let i = 0; i < 4; i++) await francois.storage.get('k');
                return { version: 1, nodes: [{ type: 'text', value: 'survived' }] };
            } }"#,
            PluginCapabilities::default(),
            host,
        )
        .unwrap();
        assert_eq!(v["nodes"][0]["value"], "survived");
    }

    #[test]
    fn the_wall_clock_deadline_still_bounds_a_slow_host() {
        // §7 #14: the CPU pause must NOT make an invocation unbounded.
        let host = Arc::new(FakeHost {
            answers: [("storage.get".to_string(), json!("v"))]
                .into_iter()
                .collect(),
            calls: StdMutex::new(Vec::new()),
            delay_ms: 1_500,
        });
        let started = Instant::now();
        let e = invoke(
            r#"export default { async panel() {
                for (let i = 0; i < 8; i++) await francois.storage.get('k');
                return { version: 1, nodes: [] };
            } }"#,
            PluginCapabilities::default(),
            host,
        )
        .unwrap_err();
        assert_eq!(e, MSG_WALL);
        assert!(
            started.elapsed().as_secs() < 20,
            "the wall deadline must actually bound it"
        );
    }

    #[test]
    fn nothing_survives_between_invocations() {
        // FR-17: a fresh runtime + context each time.
        let source = r#"export default { panel() {
            globalThis.__leak = (globalThis.__leak || 0) + 1;
            return { version: 1, nodes: [{ type: 'text', value: String(globalThis.__leak) }] };
        } }"#;
        for _ in 0..3 {
            assert_eq!(panel(source).unwrap()["nodes"][0]["value"], "1");
        }
    }

    // ---------- FR-22: the pool ----------

    #[test]
    fn a_second_invocation_for_the_same_plugin_is_dropped_not_queued() {
        // §7 #24: a tick that arrives while one is in flight is discarded.
        let pool = IsolatePool::default();
        let first = pool.acquire("acme-ci").expect("first should start");
        assert!(pool.acquire("acme-ci").is_none(), "same plugin ⇒ dropped");
        assert!(
            pool.acquire("other").is_some(),
            "a different plugin is free"
        );
        drop(first);
        assert!(pool.acquire("acme-ci").is_some(), "released on drop");
    }

    #[test]
    fn the_pool_caps_total_concurrency() {
        let pool = IsolatePool::default();
        let mut held = Vec::new();
        for i in 0..ISOLATE_MAX_CONCURRENT {
            held.push(pool.acquire(&format!("p{i}")).expect("under the cap"));
        }
        // The next one for a NEW plugin must wait, so prove it does not return
        // immediately by racing it against a release.
        let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
        std::thread::scope(|s| {
            let flag = Arc::clone(&released);
            s.spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(120));
                flag.store(true, Ordering::SeqCst);
                held.pop(); // frees one slot
            });
            let guard = pool.acquire("late").expect("eventually admitted");
            assert!(
                released.load(Ordering::SeqCst),
                "acquire returned before a slot was freed"
            );
            drop(guard);
        });
    }

    // ---------- FR-24 ----------

    #[test]
    fn a_handler_that_throws_becomes_an_error_not_a_crash() {
        let e = panel("export default { panel() { throw new Error('boom') } }").unwrap_err();
        assert!(e.contains("boom"), "{e}");
        // ...and the next invocation is completely unaffected (FR-22).
        assert_eq!(
            panel("export default { panel() { return { version: 1, nodes: [] } } }").unwrap()
                ["version"],
            1
        );
    }

    #[test]
    fn a_thrown_non_error_still_produces_a_message() {
        for source in [
            "export default { panel() { throw 'a string' } }",
            "export default { panel() { throw { code: 1 } } }",
            "export default { panel() { throw null } }",
        ] {
            assert!(!panel(source).unwrap_err().is_empty(), "{source}");
        }
    }
}
