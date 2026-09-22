// Native0.155.1 wire fixture. No model, account credentials, or project files.
const readline = require('node:readline');
const scenario = process.argv[1] || 'plain';
let initialized = false;
let count = 0;
let thread = 'opaque-fixture-thread';
let turn;
let pending;
const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => write({ id, result });
const note = (method, params) => write({ method, params });
const finish = (status = 'completed') => note('turn/completed', { threadId: thread, turn: { id: turn, status, items: [], error: null } });
const message = (text) => note('item/completed', { threadId: thread, turnId: turn, item: { type: 'agentMessage', id: 'message-' + count, text } });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    reply(msg.id, { userAgent: 'codex/0.155.1', platformFamily: 'test', platformOs: 'test' });
  } else if (msg.method === 'initialized') {
    initialized = true;
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    // exec-resume: an anchor created by `codex exec` must be resumed natively,
    // under the same account home, with no history/path import and no fresh thread.
    const execResumeViolation = scenario === 'exec-resume' && (msg.method === 'thread/start'
      || msg.params.threadId !== 'exec-created-thread' || 'history' in msg.params || 'path' in msg.params
      || process.env.CODEX_HOME !== 'fixture-codex-home');
    // restart-resume: a thread this server created before an app restart comes
    // back through thread/resume only, under the same home.
    const restartViolation = scenario === 'restart-resume' && (msg.method === 'thread/start'
      || msg.params.threadId !== 'opaque-fixture-thread' || process.env.CODEX_HOME !== 'fixture-codex-home');
    if (!initialized || execResumeViolation || restartViolation ||(msg.method === 'thread/resume' && msg.params.threadId === 'invalid-anchor')) {
      write({ id: msg.id, error: { code: -32600, message: 'private-native-error' } });
      return;
    }
    thread = msg.params.threadId || thread;
    reply(msg.id, { thread: { id: thread } });
  } else if (msg.method === 'turn/start') {
    turn = 'native-turn-' + ++count;
    reply(msg.id, { turn: { id: turn, status: 'inProgress', items: [] } });
    const started = () => {
      note('turn/started', { threadId: thread, turn: { id: turn, status: 'inProgress' } });
      if (scenario === 'stop') return;
      if (scenario === 'permission' || scenario === 'permission-eof' || scenario === 'file') {
        pending = 41;
        if (scenario === 'file') note('item/started', { threadId: thread, turnId: turn, item: { type: 'fileChange', id: 'unrelated-item', changes: [{ path: 'unrelated.txt', kind: { type: 'add' }, diff: '+other' }], status: 'inProgress' } });
        if (scenario === 'file') note('item/started', { threadId: thread, turnId: turn, item: { type: 'fileChange', id: 'file-item', changes: [{ path: 'fixture.txt', kind: { type: 'add' }, diff: '+fixture' }], status: 'inProgress' } });
        write({ id: pending, method: scenario === 'file' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: turn, itemId: scenario === 'file' ? 'file-item' : 'command-item', startedAtMs: 1, command: scenario === 'file' ? undefined : 'echo fixture', availableDecisions: scenario === 'file' ? undefined : ['accept', 'cancel'] } });
        // permission-eof: the native connection is lost while the request is pending.
        if (scenario === 'permission-eof') setTimeout(() => process.exit(0), 300);
      } else if (scenario === 'question') {
        pending = '41';
        write({ id: pending, method: 'item/tool/requestUserInput', params: { threadId: thread, turnId: turn, itemId: 'question-item', isBlocking: false, questions: [{ id: 'opaque-secret', header: 'Secret', question: 'Fixture secret', isOther: false, isSecret: true, options: null }] } });
      } else {
        note('item/agentMessage/delta', { threadId: thread, turnId: turn, itemId: 'message-' + count, delta: 'hello ' });
        // usage: the App Server's per-request (last) vs thread-cumulative (total) figures.
        if (scenario === 'usage') note('thread/tokenUsage/updated', { threadId: thread, turnId: turn, tokenUsage: { total: { totalTokens: 90000, inputTokens: 80000, cachedInputTokens: 50000, outputTokens: 10000, reasoningOutputTokens: 0 }, last: { totalTokens: 31000, inputTokens: 30000, cachedInputTokens: 20000, outputTokens: 1000, reasoningOutputTokens: 0 }, modelContextWindow: 272000 } });
        // home: echo the account home the child actually received.
        message(scenario === 'home' ? 'home:' + (process.env.CODEX_HOME || 'ambient') : 'hello turn ' + count);
        finish();
        if (scenario === 'idle-eof') process.exit(0);
      }
    };
    if (scenario === 'stop') setTimeout(started, 80); else started();
  } else if (msg.method === 'turn/interrupt') {
    reply(msg.id, {});
    finish('interrupted');
  } else if (!msg.method && msg.id === pending) {
    if (scenario === 'question' && msg.result.answers['opaque-secret'].answers[0] !== 'SENTINEL-NATIVE-SECRET') process.exit(21);
    note('serverRequest/resolved', { threadId: thread, requestId: pending });
    pending = undefined;
    message('native response accepted');
    finish(msg.result.decision === 'cancel' ? 'interrupted' : 'completed');
  }
});
