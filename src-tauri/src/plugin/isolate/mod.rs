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
use rquickjs::{CatchResultExt, Context, Function, Module, Runtime, Value as JsValue};
use std::sync::{Arc, Mutex as StdMutex};
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
///
/// FR-81: there is no `Tab` here. A contributed tab is static manifest data, so
/// no isolate ever runs for it and a plugin cannot repoint it after consent.
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
    pub logs: VecDeque<String>,
}

/// The capability-gated side of the world. `hostapi.rs` implements this; the
/// isolate deliberately knows nothing about `AppHandle`, sessions or the registry.
pub(crate) trait Host: Send + Sync {
    fn call(&self, method: &str, args: &[Value]) -> Result<Value, String>;
}

mod limits;
mod prelude;

pub(crate) use limits::*;
use prelude::*;

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
    let logs = Arc::new(StdMutex::new(VecDeque::<String>::new()));
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
    logs: &Arc<StdMutex<VecDeque<String>>>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::iso::*;
    use serde_json::json;

    // ---------- FR-19: the module contract ----------

    #[test]
    fn a_default_exported_panel_runs_and_its_value_comes_back_as_json() {
        let v = run_panel(
            "export default { panel(ctx) { return { version: 1, nodes: [{ type: 'text', value: 'hi ' + ctx.surface }] } } }",
        )
        .unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["nodes"][0]["value"], "hi panel");
    }

    #[test]
    fn an_async_handler_is_driven_to_completion() {
        // FR-21: the core drives the returned promise until it settles.
        let v = run_panel(
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
            assert_eq!(run_panel(source).unwrap(), Value::Null, "{source}");
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
            let e = run_panel(source).unwrap_err();
            assert_eq!(e, MSG_NO_DEFAULT, "{source}");
        }
    }

    #[test]
    fn a_syntax_error_reports_the_engine_message() {
        // §7 #10: the author needs the line, so the raw message is passed through.
        let e = run_panel("export default { panel() { return ( } }").unwrap_err();
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
            let e = run_panel(source).unwrap_err();
            assert!(e.contains("bundle your plugin"), "{source} → {e}");
        }
    }

    #[test]
    fn a_declared_surface_with_no_export_says_so() {
        // FR-44.
        let e = run_panel("export default { statusBar() { return null } }").unwrap_err();
        assert!(e.contains("declares a panel but exports none"), "{e}");
    }

    // ---------- FR-18: the empty global ----------

    #[test]
    fn the_intrinsics_fr_18_names_are_present() {
        let v = run_panel(
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
        let v = run_panel(
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
        let v = run_panel(
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
        let v = run_panel(
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
        let v = run_panel(
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
            ..Default::default()
        };
        let v = run_isolate(
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
        let v = run_isolate(
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
        let v = run_isolate(
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
        let e = run_isolate(
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
        assert_eq!(
            out.logs.len(),
            LOG_RING_MAX_LINES,
            "FR-26: the ring is bounded"
        );
        // FR-26: it keeps the LAST lines. 502 lines were logged; the first two —
        // the stringified one and the over-long one — have aged out, and what
        // survives is the tail next to wherever the plugin got to.
        assert_eq!(out.logs.back().unwrap(), "line499");
        assert_eq!(
            out.logs.front().unwrap(),
            &format!("line{}", 500 - LOG_RING_MAX_LINES)
        );
    }

    #[test]
    fn a_log_line_is_stringified_and_clipped() {
        // FR-26: a bare string logs as itself; everything else is JSON.
        let out = run(
            &Invocation {
                plugin_id: "acme-ci".into(),
                plugin_version: "1.0.0".into(),
                entry_source: r#"export default { panel() {
                    francois.log('hello', 42, { a: 1 }, [1,2], true, null);
                    francois.log('x'.repeat(5000));
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
    // ---------- FR-24 ----------

    #[test]
    fn a_handler_that_throws_becomes_an_error_not_a_crash() {
        let e = run_panel("export default { panel() { throw new Error('boom') } }").unwrap_err();
        assert!(e.contains("boom"), "{e}");
        // ...and the next invocation is completely unaffected (FR-22).
        assert_eq!(
            run_panel("export default { panel() { return { version: 1, nodes: [] } } }").unwrap()
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
            assert!(!run_panel(source).unwrap_err().is_empty(), "{source}");
        }
    }
}
