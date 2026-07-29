//! FR-18/FR-19/FR-25/FR-32 — the JavaScript the core injects, and the bridge
//! back out.
//!
//! Two halves that only make sense together: `PRELUDE` builds the single
//! `francois` global out of the four temporaries `install_globals` sets, then
//! deletes them; `dispatch` is what the one native function they wrap actually
//! calls. Everything crossing between them is JSON (see the module header on
//! `isolate/mod.rs`).

use super::*;

use rquickjs::{Ctx, Function};
use std::sync::{Arc, Mutex as StdMutex};

// ============================================================================
// FR-19 — the module resolver that says no
// ============================================================================

/// A v1 plugin is one self-contained file. Rejecting at RESOLVE time (rather
/// than failing to load) is what produces §7 #11's actionable message instead of
/// a bare "module not found".
pub(super) struct NoImports;

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

pub(super) struct NoLoader;

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
pub(super) const PRELUDE: &str = r#"
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

/// FR-25: install the four temporaries the prelude consumes. `__host` is the only
/// function; everything else is data.
pub(super) fn install_globals(
    ctx: &Ctx<'_>,
    inv: &Invocation,
    host: Arc<dyn Host>,
    guard: &Arc<Guard>,
    logs: &Arc<StdMutex<VecDeque<String>>>,
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
    logs: &Arc<StdMutex<VecDeque<String>>>,
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
fn record_log(logs: &Arc<StdMutex<VecDeque<String>>>, plugin_id: &str, args: &[Value]) {
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
    // FR-26: a RING keeps the LAST lines. Keeping the first 200 and dropping the
    // rest would throw away exactly the part next to the failure the user opened
    // the log to read.
    while buf.len() >= LOG_RING_MAX_LINES {
        buf.pop_front();
    }
    buf.push_back(clean_text(&line, LOG_MAX_LINE_CHARS, false));
    let _ = plugin_id;
}
