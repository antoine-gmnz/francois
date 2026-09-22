// Pure source policy for the migrated native runtime boundaries (programme 15).
// This is a lexical guard, not Rust name resolution. Rust tests prove runtime
// semantics; these checks prevent direct dependencies creeping back into ports.

const PREFIX = 'src-tauri/src/session/';
const PROBES = new Set(['models.rs', 'catalog.rs', 'usage.rs']);
const TEST_FILE = /(?:^|\/)(?:tests|testutil|testenv)(?:\/|\.rs$)|(?:^|\/)(?:tests|testutil|testenv)\.rs$|(?:[-_]tests?|\.test)\.rs$/;

function blank(text) {
  return text.replace(/[^\r\n]/g, ' ');
}

/** Mask comments and (unless `keepStrings`) Rust literals without altering
 *  line/character positions. */
export function rustCode(source, keepStrings = false) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const start = i;
    let literal = true;
    if (source.startsWith('//', i)) {
      literal = false;
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', i)) {
      literal = false;
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
    } else {
      const rest = source.slice(i);
      const raw = /^(?:br|cr|r)(#*)"/.exec(rest);
      const character = /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\r\n])'/u.exec(rest);
      if (raw) {
        const close = `"${raw[1]}`;
        const end = source.indexOf(close, i + raw[0].length);
        i = end < 0 ? source.length : end + close.length;
      } else if (source[i] === '"') {
        i++;
        while (i < source.length) {
          if (source[i] === '\\') i += 2;
          else if (source[i++] === '"') break;
        }
      } else if (character) {
        i += character[0].length;
      } else {
        out += source[i++];
        continue;
      }
    }
    out += keepStrings && literal ? source.slice(start, i) : blank(source.slice(start, i));
  }
  return out;
}

const HARNESS = String.raw`feature\s*=\s*"harness"`;
const TEST_CFG = new RegExp(
  String.raw`#\s*\[\s*cfg\s*\(\s*(?:test|any\s*\(\s*(?:test\s*,\s*${HARNESS}|${HARNESS}\s*,\s*test)\s*,?\s*\))\s*\)\s*\]`,
  'g',
);

/** Exclude test-only items: exact cfg(test), or cfg(any(test, feature = "harness"))
 *  — the `harness` feature only publishes the fixture harness to `tests/`
 *  (Cargo.toml). cfg(any(test, windows)) and friends remain production. */
export function productionRust(source, keepStrings = false) {
  const code = rustCode(source);
  const attrs = rustCode(source, true);
  const kept = keepStrings ? attrs : code;
  const test = new RegExp(TEST_CFG.source, 'g');
  let result = '';
  let cursor = 0;
  let match;
  while ((match = test.exec(attrs))) {
    let end = test.lastIndex;
    // An item's body terminates at its matching brace, or a semicolon for
    // imports/externally declared test modules. Nested attributes may occur.
    let brackets = 0;
    while (end < code.length) {
      const c = code[end++];
      if (c === '[') brackets++;
      else if (c === ']') brackets--;
      else if (brackets === 0 && c === ';') break;
      else if (brackets === 0 && c === '{') {
        let depth = 1;
        while (end < code.length && depth > 0) {
          if (code[end] === '{') depth++;
          else if (code[end] === '}') depth--;
          end++;
        }
        break;
      }
    }
    result += kept.slice(cursor, match.index) + blank(code.slice(match.index, end));
    cursor = end;
    test.lastIndex = end;
  }
  return result + kept.slice(cursor);
}

// Claude08 migrated: the adapter, its stream/control decoder and the stdio
// control channel form one native boundary (claude-process-adapter FR-1/FR-3).
const CLAUDE = [`${PREFIX}adapter/claude_code.rs`, `${PREFIX}adapter/claude_code/`, `${PREFIX}stream/`, `${PREFIX}stdio.rs`, `${PREFIX}control.rs`];

function scopeOf(path) {
  if (path.startsWith(`${PREFIX}application/`)) return 'application';
  const codex = `${PREFIX}adapter/codex/`;
  if (path.startsWith(codex) && !PROBES.has(path.slice(codex.length))) return 'codex';
  if (CLAUDE.some(prefix => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix))) return 'claude';
  return null;
}

const FORBID_FRAMEWORK = [/\b(?:tauri|AppHandle|Engine|legacy_bridge|runtime_bridge)\b/, 'native adapters publish through the injected session port and cannot acquire framework or Engine state'];
const FORBID_PUBLISH = [/\b(?:persistence|append_transcript|append_step_detail|emit|persist)\b/, 'native adapters cannot publish or persist directly; use normalized sink effects'];
const FORBID_SESSION_GLOB = [/\buse\s+crate\s*::\s*session\s*::\s*\*\s*;/, 'use explicit neutral imports; a session glob conceals Engine and concrete adapter dependencies'];
const FORBID_RAW_SPAWN = [/\b(?:std|tokio)\s*::\s*process\s*::\s*Command\b|\bCommand\s*::\s*new\b|\buse\s+[^;]*\bprocess\b[^;]*\bCommand\b/, 'spawn native processes through process_util supervision, never a raw Command or aliased constructor'];
const SIBLING = 'native adapters cannot depend on sibling provider adapters, dispatchers or their tool executors';
const RULES = {
  application: [
    [/\b(?:tauri|AppHandle|Engine|adapter|adapter_for|ClaudeCodeAdapter|CodexAdapter|GrokAdapter|OpenAiAdapter|process_util|legacy_bridge|runtime_bridge)\b/, 'application code must depend on values and ports, not framework, Engine, processes or concrete adapters'],
    [/\b(?:std|tokio)\s*::\s*(?:process\b|\{[^;]*\bprocess\b)/, 'application code cannot own process handles'],
    [/\buse\s+crate\s*::\s*session\s*::\s*\*\s*;/, 'use explicit neutral session imports; a session glob also imports Engine and adapters'],
  ],
  codex: [
    FORBID_FRAMEWORK, FORBID_PUBLISH,
    [/\b(?:ClaudeCodeAdapter|GrokAdapter|OpenAiAdapter|adapter_for)\b|\b(?:claude_code|grok|openai|pi)\b\s*(?:::|[,}])/, SIBLING],
    FORBID_SESSION_GLOB, FORBID_RAW_SPAWN,
  ],
  claude: [
    FORBID_FRAMEWORK, FORBID_PUBLISH,
    [/\b(?:CodexAdapter|GrokAdapter|OpenAiAdapter|adapter_for)\b|\b(?:codex|grok|openai|pi)\b\s*(?:::|[,}])/, SIBLING],
    FORBID_SESSION_GLOB,
    // The Claude files are flat children of `session`/`adapter`: any outer glob
    // reaches the whole session model (Engine, emit, sibling adapters).
    [/\buse\s+(?:super\s*::\s*)+\*\s*;/, 'use explicit neutral imports; an outer glob conceals forbidden dependencies'],
    FORBID_RAW_SPAWN,
  ],
};
// process-runtime-events FR-8 / claude-process-adapter AC-4: application code
// carries no vendor wire vocabulary, string literals included.
const VENDOR_VOCABULARY = /\b(?:stream_event|control_request|control_response|can_use_tool|serverRequest|jsonrpc)\b|stream-json/;

function finding(rule, path, code, match, message) {
  return { rule, severity: 'error', path, line: code.slice(0, match.index).split('\n').length, message };
}

function scopedFindings(path, source, code, scope) {
  const application = scope === 'application';
  const rules = [...RULES[scope]];
  if (scope !== 'claude') {
    const directory = `${PREFIX}${application ? 'application/' : 'adapter/codex/'}`;
    const suffix = path.slice(directory.length);
    const depth = suffix.split('/').length - (suffix.endsWith('/mod.rs') || suffix === 'mod.rs' ? 1 : 0);
    const escapingGlob = [...code.matchAll(/\buse\s+((?:super\s*::\s*)+)\*\s*;/g)]
      .find(match => (match[1].match(/super/g) ?? []).length > depth);
    if (escapingGlob) {
      rules.push([/\buse\s+(?:super\s*::\s*)+\*\s*;/, 'use explicit neutral imports when leaving the checked module; an outer glob conceals forbidden dependencies']);
    }
  }
  const rule = application ? 'native-application-boundary' : 'native-adapter-boundary';
  const out = rules.flatMap(([pattern, message]) => {
    const match = pattern.exec(code);
    return match ? [finding(rule, path, code, match, message)] : [];
  });
  if (application) {
    const literal = productionRust(source, true);
    const match = VENDOR_VOCABULARY.exec(literal);
    if (match) out.push(finding(rule, path, literal, match, 'application code cannot carry native protocol vocabulary; provider parsing stays adapter-owned'));
  }
  return out;
}

// ---- crate-wide rules (every production Rust file) ------------------------

const OPENAI = `${PREFIX}adapter/openai/`;

/** Task 11 AC-3 / FR-2: Claude and Codex run their tools inside the provider
 *  process. The only local tool executor is the Francois compatibility loop
 *  (adapter/openai, a named outer scope) and only its runner drives it. */
function toolExecutorFindings(path, code) {
  const rules = [
    [/\bopenai\s*::\s*tools\b/, !path.startsWith(OPENAI)],
    [/\btools\s*::\s*execute\b/, path !== `${OPENAI}runner.rs`],
    [/\bfn\s+(?:execute_tool|run_tool|dispatch_tool)\w*/, !path.startsWith(OPENAI)],
  ];
  const hit = rules.map(([pattern, forbidden]) => forbidden && pattern.exec(code)).find(Boolean);
  return hit ? [finding('native-tool-executor', path, code, hit, 'Francois never executes provider tool calls; tools run in the native Claude/Codex process. Only the named Francois compatibility loop (adapter/openai/runner.rs) drives a local executor')] : [];
}

/** FR-2: one session registry, one event model, one native turn-start port. */
const HOMES = [
  [/\bstruct\s+Engine\b/, [`${PREFIX}mod.rs`], 'the session registry is Engine in session/mod.rs; do not add a second one'],
  [/\benum\s+SessionEvent\b/, [`${PREFIX}events.rs`], 'SessionEvent in session/events.rs is the single event model'],
  [/\btrait\s+(?:RuntimePort|RuntimeEventSink)\b/, [`${PREFIX}application/mod.rs`], 'the native turn-start port and sink live in session/application/mod.rs only'],
  [/\btrait\s+TurnControl\b/, [`${PREFIX}application/values.rs`], 'TurnControl lives in session/application/values.rs only'],
  [/\btrait\s+SessionAdapter\b/, [`${PREFIX}adapter/mod.rs`], 'SessionAdapter is the outer dispatch trait in session/adapter/mod.rs only'],
  // The outer bridge — Tauri-aware dispatch for the migrated runtimes, the
  // Grok/Francois compatibility adapters and the retired Pi stub — by file name.
  [/\bimpl\s+(?:\w+\s*::\s*)*SessionAdapter\s+for\b/, [`${PREFIX}runtime_bridge.rs`, `${PREFIX}adapter/mod.rs`, `${PREFIX}adapter/grok/mod.rs`, `${OPENAI}runner.rs`], 'native adapters implement RuntimePort; only the named outer bridge implements SessionAdapter'],
  [/\bimpl\s+(?:\w+\s*::\s*)*RuntimePort\s+for\b/, [`${PREFIX}adapter/claude_code.rs`, `${PREFIX}adapter/codex/mod.rs`, `${PREFIX}adapter/codex/native/runtime.rs`, `${PREFIX}runtime_bridge.rs`], 'RuntimePort is implemented by the Claude/Codex adapters and the legacy bridge only'],
  [/\bEventBus\b|\bbroadcast\s*::\s*channel\b/, [], 'no event bus: runtime events flow through RuntimeEventSink into the reducer'],
];

function seamFindings(path, code) {
  const out = HOMES.flatMap(([pattern, homes, message]) => {
    const match = homes.includes(path) ? null : pattern.exec(code);
    return match ? [finding('native-seam', path, code, match, message)] : [];
  });
  for (const match of code.matchAll(/\btrait\s+(\w+)[^{;]*\{/g)) {
    if (match[1] === 'RuntimePort' || match[1] === 'SessionAdapter') continue;
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < code.length && depth > 0) {
      if (code[end] === '{') depth++;
      else if (code[end] === '}') depth--;
      end++;
    }
    if (/\bfn\s+begin_turn\b/.test(code.slice(match.index, end))) {
      out.push(finding('native-seam', path, code, match, 'a second turn-start trait; native turns start through RuntimePort only'));
    }
  }
  return out;
}

/** Module paths a parent declares only as `#[cfg(test)] mod name;`. */
function testModules(files) {
  const out = [];
  const declaration = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:#\s*\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g;
  for (const { path, source } of files) {
    if (!path.endsWith('.rs') || typeof source !== 'string') continue;
    const dir = /\/(?:mod|lib|main)\.rs$/.test(path) ? path.slice(0, path.lastIndexOf('/')) : path.slice(0, -3);
    for (const match of rustCode(source).matchAll(declaration)) out.push(`${dir}/${match[1]}`);
  }
  return out;
}

/** Same finding format as conventions.mjs; no ratchet/exemption baseline. */
export function nativeBoundaryFindings(files) {
  const normalized = files.map(file => ({ ...file, path: file.path.replaceAll('\\', '/') }));
  const tests = testModules(normalized);
  return normalized.flatMap(({ path, source }) => {
    if (typeof source !== 'string' || !/^src-tauri\/src\/.+\.rs$/.test(path) || TEST_FILE.test(path)) return [];
    if (tests.some(module => path === `${module}.rs` || path.startsWith(`${module}/`))) return [];
    const scope = scopeOf(path);
    const code = productionRust(source);
    return [
      ...(scope ? scopedFindings(path, source, code, scope) : []),
      ...toolExecutorFindings(path, code),
      ...seamFindings(path, code),
    ];
  });
}
