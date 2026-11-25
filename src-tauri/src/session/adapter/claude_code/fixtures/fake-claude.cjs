// Fake `claude -p --output-format stream-json --input-format stream-json` child.
// Shapes are copied from the real 2.1.228 capture (session/stream/fixtures/turn.ndjson).
// No model, account credentials, network or project files.
// argv: <scenario | golden:<ndjson path>> <record file> <...the claude argv the adapter built>
const fs = require('node:fs');
const readline = require('node:readline');
const [scenario, record, ...argv] = process.argv.slice(1);
const log = (value) => fs.appendFileSync(record, JSON.stringify(value) + '\n');
log({ pid: process.pid, argv, home: process.env.CLAUDE_CONFIG_DIR || null, cwd: process.cwd() });
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const thread = flag('--resume') || 'fresh-claude-thread';
const write = (value) => process.stdout.write(JSON.stringify({ ...value, session_id: thread }) + '\n');
const event = (e) => write({ type: 'stream_event', event: e, parent_tool_use_id: null });
const init = () => write({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Read', 'Bash', 'AskUserQuestion'], mcp_servers: [], model: flag('--model') });
const usage = (input, output) => ({ input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: input, output_tokens: output });
const text = (index, chunks) => {
  event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  for (const chunk of chunks) event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } });
  event({ type: 'content_block_stop', index });
};
const result = (extra = {}) => write({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: usage(3400000, 100), ...extra });
const ask = (request_id, tool_name, input) => write({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name, input } });

// Pipe writes are asynchronous on Windows: exit only once stdout has drained.
const exitFlushed = (code) => process.stdout.write('', () => process.exit(code));
let expected = 0; // control responses the scenario waits for before its result
let answered = 0;
let lines = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  log({ stdin: JSON.parse(line) });
  const msg = JSON.parse(line);
  if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'get_context_usage') return contextUsage(msg.request_id);
  if (++lines === 1) return start();
  if (scenario === 'background' && JSON.parse(line).type === 'user') return reply();
  if (JSON.parse(line).type === 'control_response' && ++answered === expected) result();
}).on('close', () => process.exit(0)); // stdin EOF is what ends a stream-json CLI

// token-viewer FR-11: the `get_context_usage` side-probe, answered with no turn.
// Scenarios: `context:<fixture path>` answers with that capture's response (the
// resumed fixture), echoing the caller's request_id; `context-slow:<path>` the
// same after 400ms; `context-error` refuses it like an older CLI; `context-exit`
// dies first; `context-hang` never answers. A hook line and a reply to someone
// else's request always come first — the probe must skip both.
function contextUsage(request_id) {
  const reply = (response) => process.stdout.write(JSON.stringify({ type: 'control_response', response }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup', stdout: '' }) + '\n');
  reply({ subtype: 'success', request_id: 'someone-else', response: {} });
  if (scenario === 'context-exit') return exitFlushed(2);
  if (scenario === 'context-hang') return;
  if (scenario === 'context-error') return reply({ subtype: 'error', request_id, error: 'Unsupported control request subtype: get_context_usage' });
  const [kind, ...rest] = scenario.split(':');
  const answer = () => {
    const captured = JSON.parse(fs.readFileSync(rest.join(':'), 'utf8').split('\n')[0]);
    reply({ ...captured.response, request_id });
  };
  if (kind === 'context-slow') return setTimeout(answer, 400);
  if (kind === 'context') return answer();
}

// The user's reply lands in the live process: answer it, stop the stack, done.
function reply() {
  event({ type: 'message_start', message: { usage: usage(40100, 1) } });
  text(0, ['great, stopping it']);
  event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage(40100, 10) });
  write({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  result();
}

function start() {
  if (scenario === 'resume-rejected') process.exit(1); // the CLI refuses an unknown --resume before init
  if (scenario.startsWith('golden:')) {
    process.stdout.write(fs.readFileSync(scenario.slice('golden:'.length), 'utf8'));
    return exitFlushed(0); // the capture's asks were answered live; this replay leaves them parked
  }
  init();
  event({ type: 'message_start', message: { usage: usage(40000, 1) } });
  if (scenario === 'text' || scenario === 'resume') {
    text(0, ['hello ', 'from ', 'fake claude']);
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage(40000, 500) });
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello from fake claude' }] }, parent_tool_use_id: null });
    result();
  } else if (scenario === 'tool') {
    event({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_read', name: 'Read', input: {} } });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"README.md"}' } });
    event({ type: 'content_block_stop', index: 0 });
    write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'README.md' } }] }, parent_tool_use_id: null });
    write({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_read', type: 'tool_result', content: '1\t# fixture readme' }] }, parent_tool_use_id: null });
    event({ type: 'message_start', message: { usage: usage(41000, 1) } });
    text(0, ['read it']);
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage(41000, 20) });
    result();
  } else if (scenario === 'permission') {
    expected = 2;
    ask('req-allow', 'Bash', { command: 'mkdir build', description: 'Create a build directory' });
    ask('req-deny', 'Bash', { command: 'rmdir build', description: 'Remove it again' });
  } else if (scenario === 'question') {
    expected = 1;
    ask('req-question', 'AskUserQuestion', { questions: [{ question: 'Which environment?', header: 'Environment', options: [{ label: 'staging', description: 'the staging environment' }, { label: 'production', description: 'the production environment' }], multiSelect: false }] });
  } else if (scenario === 'park') {
    ask('req-parked', 'Bash', { command: 'mkdir parked', description: 'Parked forever' });
  } else if (scenario === 'hang') {
    text(0, ['working']);
  } else if (scenario === 'crash') {
    text(0, ['partial']);
    exitFlushed(3);
  } else if (scenario === 'background') {
    // "Start the stack and tell me if it looks good": a background Bash that
    // outlives the turn, a plain-text question, then the result — the CLI stays
    // alive on stdin until the task is gone (real 2.1.x behaviour).
    write({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg-stack', type: 'local_bash' }] });
    text(0, ['Stack started, tell me if it looks good']);
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage(40000, 20) });
    result();
  } else if (scenario === 'resumed-agent') {
    // SendMessage woke an agent dispatched by a PREVIOUS process: the task line
    // names the SendMessage call, the agent's own lines the original Agent call.
    write({ type: 'system', subtype: 'task_started', task_id: 'task-reviewer', tool_use_id: 'toolu_send', description: 'Review WW-197', subagent_type: 'waati:waati-reviewer', is_backgrounded: true, task_type: 'local_agent' });
    write({ type: 'assistant', parent_tool_use_id: 'toolu_agent_from_before', agent_id: 'task-reviewer', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Read', input: { file_path: 'README.md' } }] } });
    write({ type: 'system', subtype: 'task_notification', task_id: 'task-reviewer', tool_use_id: 'toolu_send', status: 'completed' });
    text(0, ['review done']);
    result();
  } else if (scenario === 'crash-parked') {
    // Dies with an approval still parked: the card must never outlive the process.
    ask('req-orphan', 'Bash', { command: 'mkdir orphan', description: 'Never answered' });
    exitFlushed(3);
  }
}
