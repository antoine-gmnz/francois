// Native0.155.1 wire fixture. No model, account credentials, or project files.
const readline = require('node:readline');
const scenario = process.argv[1] || 'plain';
let initialized = false;
let count = 0;
let thread = 'opaque-fixture-thread';
let threads = 0;
let turn;
let pending;
let baseInstructions;
let remoteStatus = 'disabled';
let pairings = 0;
let remoteReads = 0;
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
    if (scenario === 'child-subscribe-fail' && msg.params.threadId === 'child-thread') { write({id:msg.id,error:{code:-32600,message:'observation unavailable'}}); return; }
    if (msg.params.threadId === 'child-thread') { reply(msg.id,{thread:{id:'child-thread',turns:[]}}); return; }
    baseInstructions = msg.params.baseInstructions;
    // fresh-threads: every thread/start opens a new thread, as the real server does.
    if (scenario === 'fresh-threads' && msg.method === 'thread/start') thread = 'fresh-thread-' + ++threads;
    thread = msg.params.threadId || thread;
    reply(msg.id, { thread: { id: thread } });
  } else if (msg.method === 'skills/list') {
    reply(msg.id, {data:[{cwd:msg.params.cwds[0],errors:[],skills:[{name:'demo',description:'demo',path:'/tmp/demo/SKILL.md',scope:'user',enabled:true}]}]});
  } else if (msg.method === 'config/mcpServer/reload') {
    reply(msg.id, {});
  } else if (msg.method === 'turn/start') {
    // die: the process prints why on stderr and exits mid-request.
    if (scenario === 'die') { process.stderr.write('noise before\nError: fixture exploded\n', () => process.exit(3)); return; }
    // reject-turn: Codex refuses the request with its own explanation.
    if (scenario === 'reject-turn') { write({ id: msg.id, error: { code: -32602, message: 'model fixture-model is not available' } }); return; }
    turn = 'native-turn-' + ++count;
    reply(msg.id, { turn: { id: turn, status: 'inProgress', items: [] } });
    const started = () => {
      note('turn/started', { threadId: thread, turn: { id: turn, status: 'inProgress' } });
      if (scenario === 'stop') return;
      if (scenario === 'profile' || scenario === 'plan-mode') {
        message(scenario === 'profile' ? (baseInstructions || 'IGNORED') : (msg.params.collaborationMode?.mode || 'default'));
        finish();
        return;
      }
      if (scenario === 'skill-prefix') { message(JSON.stringify(msg.params.input)); finish(); return; }
      if (scenario === 'agents' || scenario === 'child-subscribe-fail') {
        note('item/completed', { threadId: thread, turnId: turn, item: { type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed', senderThreadId: thread, receiverThreadIds: ['child-thread'], prompt: 'Audit files', model: 'fixture-model', agentsStates: { 'child-thread': { status: 'running', message: null } } } });
        if (scenario === 'child-subscribe-fail') { finish(); return; }
        note('turn/started', { threadId: 'child-thread', turn: { id: 'child-turn', status: 'inProgress' } });
        note('item/completed', { threadId: 'child-thread', turnId: 'child-turn', item: { type: 'agentMessage', id: 'child-message', text: 'child result' } });
        note('turn/completed', { threadId: 'child-thread', turn: { id: 'child-turn', status: 'completed', items: [], error: null } });
        finish();
        return;
      }
      if (scenario === 'permission' || scenario === 'permission-eof' || scenario === 'file') {
        pending = 41;
        if (scenario === 'file') note('item/started', { threadId: thread, turnId: turn, item: { type: 'fileChange', id: 'unrelated-item', changes: [{ path: 'unrelated.txt', kind: { type: 'add' }, diff: '+other' }], status: 'inProgress' } });
        if (scenario === 'file') note('item/started', { threadId: thread, turnId: turn, item: { type: 'fileChange', id: 'file-item', changes: [{ path: 'fixture.txt', kind: { type: 'add' }, diff: '+fixture' }], status: 'inProgress' } });
        write({ id: pending, method: scenario === 'file' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params: { threadId: thread, turnId: turn, itemId: scenario === 'file' ? 'file-item' : 'command-item', startedAtMs: 1, command: scenario === 'file' ? undefined : 'echo fixture', availableDecisions: scenario === 'file' ? undefined : ['accept', 'cancel'] } });
        // permission-eof: the native connection is lost while the request is pending.
        if (scenario === 'permission-eof') setTimeout(() => process.exit(0), 300);
      } else if (scenario === 'mcp-approval') {
        // Shape verbatim from a live 0.155.1 capture: an MCP tool call asks
        // through an elicitation, with an integer id that can be 0.
        pending = 0;
        write({ id: pending, method: 'mcpServer/elicitation/request', params: { threadId: thread, turnId: turn, serverName: 'echo', mode: 'form',
          _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_description: 'Echo text back', tool_params: { text: 'ping' } },
          message: 'Allow the echo MCP server to run tool "echo"?', requestedSchema: { type: 'object', properties: {} } } });
      } else if (scenario === 'question') {
        pending = '41';
        write({ id: pending, method: 'item/tool/requestUserInput', params: { threadId: thread, turnId: turn, itemId: 'question-item', isBlocking: false, questions: [{ id: 'opaque-secret', header: 'Secret', question: 'Fixture secret', isOther: false, isSecret: true, options: null }] } });
      } else if (scenario === 'failed' || scenario === 'error') {
        // failed: a retried error is not terminal; the turn's own error is.
        // error: a non-retried `error` notification ends the turn itself.
        const retry = scenario === 'failed';
        note('error', { threadId: thread, turnId: turn, willRetry: retry, error: retry
          ? { message: 'Reconnecting... 1/5', codexErrorInfo: null, additionalDetails: null }
          : { message: 'stream disconnected before completion', codexErrorInfo: 'other', additionalDetails: null } });
        note('turn/completed', { threadId: thread, turn: { id: turn, status: 'failed', items: [], error: retry
          ? { message: 'Rate limit reached for gpt-fixture', codexErrorInfo: 'rateLimitExceeded', additionalDetails: 'Try again in 20s.' }
          : { message: 'stream disconnected before completion', codexErrorInfo: 'other', additionalDetails: 'responseStreamDisconnected' } } });
      } else if (scenario === 'live-plan') {
        // Params verbatim from a live 0.155.1 capture (gpt-6-astra, update_plan on).
        note('turn/plan/updated', { threadId: thread, turnId: turn, explanation: null, plan: [
          { step: 'Prepare the text for hello.txt.', status: 'inProgress' }, { step: 'Write the text to hello.txt.', status: 'pending' },
          { step: 'Verify the contents of hello.txt.', status: 'pending' }] });
        finish();
      } else if (scenario === 'plan' || scenario === 'edit' || scenario === 'mcp') {
        // Shapes verbatim from live 0.155.1 captures (fileChange) and the
        // generated v2 schema (turn/plan/updated, mcpToolCall).
        if (scenario === 'plan') note('turn/plan/updated', { threadId: thread, turnId: turn, explanation: null, plan: [
          { step: 'Read the code', status: 'completed' }, { step: 'Fix the bug', status: 'inProgress' }, { step: 'Run the tests', status: 'pending' }] });
        const item = scenario === 'edit'
          ? { type: 'fileChange', id: 'edit-item', status: 'completed', changes: [
            { path: require('node:path').join(process.cwd(), 'existing.txt'), kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n' },
            { path: 'new.txt', kind: { type: 'add' }, diff: 'one\ntwo\n' }] }
          : { type: 'mcpToolCall', id: 'mcp-item', server: 'docs', tool: 'search', status: 'completed', arguments: { query: 'tauri events' },
            result: { content: [{ type: 'text', text: 'found 2 pages' }], structuredContent: null }, error: null, durationMs: 12 };
        if (scenario !== 'plan') {
          note('item/started', { threadId: thread, turnId: turn, item: { ...item, status: 'inProgress', result: null } });
          note('item/completed', { threadId: thread, turnId: turn, item });
        }
        message('done');
        finish();
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
  } else if (msg.method?.startsWith('remoteControl/')) {
    if (msg.method === 'remoteControl/enable' || msg.method === 'remoteControl/disable') {
      if (msg.params.ephemeral !== true) process.exit(42);
      remoteStatus = msg.method.endsWith('/enable') ? (scenario === 'remote-warmup' ? 'connecting' : 'connected') : 'disabled';
      reply(msg.id, { status: remoteStatus, serverName: 'fixture', installationId: 'fixture-install', environmentId: 'native-environment' });
    } else if (msg.method === 'remoteControl/status/read') {
      if (scenario === 'remote-warmup' && ++remoteReads >= 2) remoteStatus = 'connected';
      reply(msg.id, { status: remoteStatus, serverName: 'fixture', installationId: 'fixture-install', environmentId: 'native-environment' });
    } else if (msg.method === 'remoteControl/pairing/start') {
      if (remoteStatus !== 'connected') { write({id:msg.id,error:{code:-32600,message:'enrollment incomplete'}}); return; }
      if (msg.params.manualCode !== true) { write({ id: msg.id, error: { code: -32600, message: 'manual pairing requested' } }); return; }
      reply(msg.id, { pairingCode: 'OPAQUE-'+ ++pairings, manualPairingCode: 'MANUAL-'+pairings, environmentId: 'native-environment', expiresAt: Math.floor(Date.now() / 1000) + 600 });
    }
  } else if (msg.method === 'thread/compact/start') {
    turn = 'native-turn-' + ++count;
    reply(msg.id, {});
    note('turn/started', { threadId: thread, turn: { id: turn, status: 'inProgress' } });
    note('item/completed', { threadId: thread, turnId: turn, item: { type: 'contextCompaction', id: 'compact-item' } });
    finish();
  } else if (msg.method === 'turn/interrupt') {
    reply(msg.id, {});
    finish('interrupted');
  } else if (!msg.method && msg.id === pending) {
    if (scenario === 'question' && msg.result.answers['opaque-secret'].answers[0] !== 'SENTINEL-NATIVE-SECRET') process.exit(21);
    // An elicitation is answered with an MCP action, never a `decision`.
    if (scenario === 'mcp-approval' && (msg.result.action !== 'accept' || JSON.stringify(msg.result.content) !== '{}' || 'decision' in msg.result)) process.exit(22);
    note('serverRequest/resolved', { threadId: thread, requestId: pending });
    pending = undefined;
    message('native response accepted');
    finish(msg.result.decision === 'cancel' ? 'interrupted' : 'completed');
  }
});
