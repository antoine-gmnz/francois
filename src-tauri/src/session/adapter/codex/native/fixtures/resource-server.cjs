// Deterministic native resources peer. All homes and paths are synthetic.
const readline = require('node:readline');
const fs = require('node:fs');
const cwd = process.cwd();
const home = process.env.CODEX_HOME;
const configFile = `${home}/resource-config.json`;
let config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
function reply(id, result) { process.stdout.write(JSON.stringify({id, result}) + '\n'); }
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(`${home}/resource-calls.jsonl`, JSON.stringify(message) + '\n');
  switch (message.method) {
    case 'initialize': reply(message.id, {userAgent:'fixture'}); break;
    case 'initialized': break;
    case 'config/read':
      if (message.params.cwd !== cwd) throw Error('wrong cwd');
      reply(message.id, {config, layers:[{name:{type:'user',file:`${home}/config.toml`},version:'v1',config,disabledReason:null}]}); break;
    case 'mcpServerStatus/list':
      reply(message.id, {data:Object.keys(config.mcp_servers).map(name => ({name,runtimeStatus:message.params.threadId ? 'connected' : null,tools:{one:{}},toolsError:null})),nextCursor:null}); break;
    case 'config/value/write':
      config.mcp_servers = message.params.value;
      fs.writeFileSync(configFile, JSON.stringify(config)); reply(message.id,{}); break;
    case 'config/mcpServer/reload': reply(message.id,{}); break;
    case 'skills/list':
      if (message.params.cwds[0] !== cwd) throw Error('wrong skill cwd');
      reply(message.id,{data:[{cwd,skills:[{name:'demo',description:'native fixture',path:`${home}/skills/demo/SKILL.md`,scope:'user',enabled:config.skillEnabled,pluginId:null}],errors:[]}]}); break;
    case 'skills/config/write':
      if (message.params.path !== `${home}/skills/demo/SKILL.md`) throw Error('wrong skill path');
      config.skillEnabled = message.params.enabled;
      fs.writeFileSync(configFile, JSON.stringify(config)); reply(message.id,{}); break;
    default: throw Error(`Unexpected method ${message.method}`);
  }
});
