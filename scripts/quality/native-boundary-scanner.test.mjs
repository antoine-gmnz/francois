import { describe, expect, it } from 'vitest';
import { nativeBoundaryFindings, productionRust } from './native-boundary.mjs';
import { allFindings } from './conventions.mjs';

const application = 'src-tauri/src/session/application/commands.rs';
const native = 'src-tauri/src/session/adapter/codex/native/client.rs';
const scan = (source, path = application) => nativeBoundaryFindings([{ path, source }]);

describe('application dependency boundary', () => {
  it.each([
    'use tauri::Manager;',
    'pub use crate::session::Engine as Store;',
    'use std::{process::{Child as Handle}};',
    'use crate::process_util::OwnedChild as Handle;',
    'use crate::session::adapter::{codex::CodexAdapter as Runtime};',
    'use super::runtime_bridge::RuntimeBridge;',
    'type Handle = tauri::AppHandle;',
    'use crate::session::*;',
  ])('rejects forbidden dependency including grouped imports/aliases: %s', source => {
    expect(scan(source).some(f => f.rule === 'native-application-boundary')).toBe(true);
  });
  it('accepts value ports and synchronization', () => {
    expect(scan('use super::{RuntimePort, TurnContext}; use std::sync::{Arc, Mutex}; use crate::ipc::AppError;')).toEqual([]);
  });
});

describe('native adapter boundary', () => {
  it.each([
    'use tauri::{AppHandle as Application, Manager};',
    'let state = app.state::<Engine>();',
    'pub use crate::session::persistence::append_transcript as save;',
    'use crate::session::{emit as publish, persist};',
    'app.emit("topic", value);',
    'use super::super::{claude_code::ClaudeCodeAdapter as Other};',
    'pub use super::super::GrokAdapter as Other;',
    'use super::super::OpenAiAdapter;',
    'let adapter = adapter_for(runtime);',
    'use crate::session::adapter::openai::tools::execute;',
    'use crate::session::*;',
    'use std::process::Command as Cmd; Cmd::new("codex").spawn();',
    'std::process::Command::new("codex").spawn();',
    'use std::{process::{Command as Cmd}}; Cmd::new("codex");',
  ])('rejects coupling/raw process creation: %s', source => {
    expect(scan(source, native).length).toBeGreaterThan(0);
  });
  it('accepts normalized sink and supervised child', () => {
    expect(scan('use crate::session::application::{RuntimeEventSink, RuntimePort}; use std::process::Stdio; let child = crate::process_util::spawn(program).start_owned()?; sink.publish(event);', native)).toEqual([]);
  });
  it('enforces every future native child, not just initial five files', () => {
    expect(scan('use tauri::AppHandle;', native)).toHaveLength(1);
  });
  it('exempts only named read-model probes and explicitly outer bridges', () => {
    for (const path of ['models.rs', 'catalog.rs', 'usage.rs']) {
      expect(scan('use tauri::AppHandle;', `src-tauri/src/session/adapter/codex/${path}`)).toEqual([]);
    }
    expect(scan('use tauri::AppHandle;', 'src-tauri/src/session/runtime_bridge.rs')).toEqual([]);
    expect(scan('use tauri::AppHandle;', 'src-tauri/src/session/adapter/codex/native/models.rs')).toHaveLength(1);
  });
});

describe('production Rust lexical handling', () => {
  it('ignores nested comments, escaped/raw strings, chars and exact cfg(test) items', () => {
    const source = '// use tauri::AppHandle;\n/* Engine /* nested */ std::process */\nconst DOC: &str = r##"use tauri::Manager; Engine"##;\nconst TEXT: &str = "quoted \\" Engine";\nconst CHAR: char = \'"\';\n#[cfg(test)]\nmod tests { use tauri::AppHandle; fn f() { let s = "}"; } }\nuse super::TurnContext;';
    expect(scan(source)).toEqual([]);
    expect(productionRust(source).split('\n')).toHaveLength(source.split('\n').length);
  });
  it('does not hide production after test items or cfg(any(test, windows))', () => {
    expect(scan('#[cfg(test)] mod tests { fn f() {} }\nuse tauri::AppHandle;')).toHaveLength(1);
    expect(scan('#[cfg(any(test, windows))] use tauri::Manager;')).toHaveLength(1);
  });
  it('handles lifetimes without swallowing subsequent code', () => {
    expect(scan("fn f<'a>(s: &'a str) { let _: Engine; }")).toHaveLength(1);
  });
  it('ignores dedicated tests but not production files containing test in their name', () => {
    expect(scan('use tauri::AppHandle;', 'src-tauri/src/session/application/tests/fixtures.rs')).toEqual([]);
    expect(scan('use tauri::AppHandle;', 'src-tauri/src/session/application/latest.rs')).toHaveLength(1);
  });
});

it('the convention aggregation used by CLI and CI fails forbidden imports', () => {
  expect(allFindings([{ path: application, source: 'use tauri::AppHandle;', lines: 1, imports: [] }])
    .some(f => f.rule === 'native-application-boundary' && f.severity === 'error')).toBe(true);
});

// programme 15: Claude08 is migrated, so its adapter + decoder paths are enforced.
describe('Claude native adapter boundary', () => {
  const claudePaths = [
    'src-tauri/src/session/adapter/claude_code.rs',
    'src-tauri/src/session/adapter/claude_code/context.rs',
    'src-tauri/src/session/stream/lines.rs',
    'src-tauri/src/session/stream/mod.rs',
    'src-tauri/src/session/stdio.rs',
    'src-tauri/src/session/control.rs',
  ];
  it.each(claudePaths)('enforces %s', path => {
    expect(scan('use tauri::AppHandle;', path)).toHaveLength(1);
  });
  it.each([
    'let state = app.state::<Engine>();',
    'crate::session::emit(app, event);',
    'use crate::session::persistence::append_transcript;',
    'use crate::session::adapter::codex::CodexAdapter;',
    'use super::super::codex::translate;',
    'use crate::session::adapter::openai::tools::execute;',
    'use crate::session::*;',
    'use super::*;',
    'std::process::Command::new("claude").spawn();',
    'crate::session::runtime_bridge::project_runtime_event(env, "s1", "", e);',
  ])('rejects coupling in the Claude adapter: %s', source => {
    expect(scan(source, claudePaths[0]).some(f => f.rule === 'native-adapter-boundary')).toBe(true);
  });
  it('accepts explicit neutral imports, the sink and a supervised child', () => {
    expect(scan('use super::{TurnContext, TurnControl}; use crate::session::{now_ms, PendingQuestion}; use crate::session::application::RuntimeEventSink; let c = crate::process_util::spawn(p).start_owned()?;', claudePaths[0])).toEqual([]);
  });
  it('treats cfg(any(test, feature = "harness")) as test infrastructure, not production', () => {
    expect(scan('#[cfg(any(test, feature = "harness"))]\nimpl<T> X for T { fn f() { crate::session::runtime_bridge::f(); } }', claudePaths[2])).toEqual([]);
    expect(scan('#[cfg(any(feature = "harness", windows))] use tauri::Manager;', claudePaths[2])).toHaveLength(1);
  });
  it('skips files declared only as #[cfg(test)] modules by their parent', () => {
    const files = [
      { path: 'src-tauri/src/session/stream/mod.rs', source: '#[cfg(test)]\nmod coalesce;\nmod lines;' },
      { path: 'src-tauri/src/session/stream/coalesce.rs', source: 'fn engine(&self) -> &Engine { todo!() }' },
      { path: 'src-tauri/src/session/stream/lines.rs', source: 'fn engine(&self) -> &Engine { todo!() }' },
    ];
    expect(nativeBoundaryFindings(files).map(f => f.path)).toEqual(['src-tauri/src/session/stream/lines.rs']);
  });
});

describe('application vendor vocabulary', () => {
  it.each(['"control_request"', '"stream-json"', '"can_use_tool"', '"jsonrpc"', 'json!({"type": "stream_event"})'])('rejects native protocol strings in application code: %s', literal => {
    expect(scan(`const X: &str = ${literal};`).some(f => f.rule === 'native-application-boundary')).toBe(true);
  });
  it('ignores the vocabulary in comments', () => {
    expect(scan('// maps control_request to a card\nuse super::TurnContext;')).toEqual([]);
  });
});

describe('no local tool executor for native runtimes (task 11 AC-3)', () => {
  const at = (path, source) => nativeBoundaryFindings([{ path: `src-tauri/src/${path}`, source }])
    .filter(f => f.rule === 'native-tool-executor');
  it.each([
    ['session/adapter/codex/native/client.rs', 'crate::session::adapter::openai::tools::execute(t, p, c, i);'],
    ['session/turn.rs', 'use crate::session::adapter::openai::tools;'],
    ['session/commands/lifecycle.rs', 'fn execute_tool(call: &Value) -> String { String::new() }'],
    ['session/adapter/claude_code.rs', 'fn run_tool_call(call: &Value) {}'],
    ['session/adapter/openai/blocks.rs', 'super::tools::execute(t, p, c, i)'],
  ])('rejects a tool executor outside the named Francois bridge: %s', (path, source) => {
    expect(at(path, source)).toHaveLength(1);
  });
  it('allows only the Francois compatibility loop to drive its own tools', () => {
    expect(at('session/adapter/openai/runner.rs', 'super::tools::execute(tool, p, c, input)')).toEqual([]);
    expect(at('session/adapter/openai/tools.rs', 'pub fn execute(tool: &str) -> String { bash(p, a) }')).toEqual([]);
  });
});

describe('one session registry, event model and native turn-start seam (FR-2)', () => {
  const at = (path, source) => nativeBoundaryFindings([{ path: `src-tauri/src/${path}`, source }])
    .filter(f => f.rule === 'native-seam');
  it.each([
    ['session/adapter/codex/native/state.rs', 'pub struct Engine { x: u8 }'],
    ['session/runtime_events.rs', 'pub enum SessionEvent { A }'],
    ['session/application/values.rs', 'pub(crate) trait RuntimePort { }'],
    ['session/adapter/claude_code.rs', 'trait NativeStart { fn begin_turn(&self); }'],
    ['session/adapter/claude_code.rs', 'impl SessionAdapter for ClaudeCodeAdapter { }'],
    ['session/adapter/codex/native/runtime.rs', 'impl SessionAdapter for NativeRuntime { }'],
    ['session/turn.rs', 'impl RuntimePort for Direct { }'],
    ['session/events.rs', 'pub struct EventBus;'],
    ['session/events.rs', 'let (tx, _) = tokio::sync::broadcast::channel(8);'],
  ])('rejects a duplicate seam in %s', (path, source) => {
    expect(at(path, source)).toHaveLength(1);
  });
  it('accepts the canonical definitions and the named outer bridges', () => {
    expect(at('session/mod.rs', 'pub struct Engine { x: u8 }')).toEqual([]);
    expect(at('session/events.rs', 'pub enum SessionEvent { A }')).toEqual([]);
    expect(at('session/application/mod.rs', 'pub(crate) trait RuntimePort { fn begin_turn(&self); }')).toEqual([]);
    expect(at('session/adapter/mod.rs', 'pub(crate) trait SessionAdapter { fn begin_turn(&self); } impl SessionAdapter for PiAdapter {}')).toEqual([]);
    expect(at('session/runtime_bridge.rs', 'impl SessionAdapter for adapter::ClaudeCodeAdapter {} impl RuntimePort for LegacyRuntimeBridge<\'_> {}')).toEqual([]);
    expect(at('session/adapter/claude_code.rs', 'impl RuntimePort for ClaudeCodeAdapter {}')).toEqual([]);
    expect(at('session/adapter/codex/native/runtime.rs', 'impl RuntimePort for NativeRuntime {}')).toEqual([]);
    expect(at('session/adapter/grok/mod.rs', 'impl SessionAdapter for GrokAdapter {}')).toEqual([]);
  });
});
