// Executable fixture: no model, credentials, network, extensions or user config.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const trace = value => { if (process.env.FAKE_PI_TRACE) appendFileSync(process.env.FAKE_PI_TRACE, JSON.stringify({ pid: process.pid, ...value }) + '\n'); };
trace({ kind: 'start', args });
if (args.includes('--version')) { console.log(process.env.FAKE_PI_VERSION || '1.1.0'); process.exit(0); }
if (args.includes('--help')) { console.log('Options:\n  --mode <mode>    Mode\n  --print, -p      Print\n'); process.exit(0); }
if (args.includes('--print')) { console.log('测试会话'); process.exit(0); }
const promptPath = args[args.indexOf('--append-system-prompt') + 1];
const instructions = args.includes('--append-system-prompt') ? readFileSync(promptPath, 'utf8') : '';
const word = instructions.match(/reply with exactly (\S+) and nothing else/)?.[1] ?? '';
const model = { provider: 'fake', id: 'fake', name: 'Fake', reasoning: false, contextWindow: 128000, maxTokens: 1000, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const data = {
  get_state: { model, thinkingLevel: 'off', isStreaming: false, sessionId: 'fake-session', messageCount: 0 },
  get_available_models: { models: [model] }, get_available_thinking_levels: { levels: ['off'] }, get_commands: { commands: [] },
  get_session_stats: { tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 }, cost: 0, contextUsage: { tokens: 20, contextWindow: 128000, percent: 0.01 } },
};
const out = record => process.stdout.write(JSON.stringify(record) + '\n');
const text = delta => out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
let timer, active = false;
const settle = aborted => { clearTimeout(timer); if (active) { active = false; out({ type: 'agent_settled', aborted }); trace({ kind: 'settled', aborted }); } };
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line); trace({ kind: 'rpc', command });
  if (process.env.FAKE_PI_FAIL === command.type) { out({ type: 'response', id: command.id, command: command.type, success: false, error: 'fake failure' }); return; }
  out({ type: 'response', id: command.id, command: command.type, success: true, data: command.type === 'prompt' ? { disposition: 'started' } : command.type === 'steer' ? { disposition: 'queued' } : data[command.type] ?? {} });
  if (command.type === 'prompt') {
    active = true;
    // Pi declares result payloads as any: exercise the plugin's runtime array guard.
    out({type:'tool_execution_start',toolCallId:command.id,toolName:'read',args:{path:'fake'}});
    for (const partialResult of [null, 1, {}, {content:'not an array'}]) out({type:'tool_execution_update',toolCallId:command.id,partialResult});
    out({type:'tool_execution_end',toolCallId:command.id,isError:false,result:{content:42}});
    text(command.message.includes('Coda check word') ? word : 'ok\n');
    timer = setTimeout(() => settle(false), 400);
  }
  if (command.type === 'abort') settle(true);
  if (command.type === 'steer' && active) text('插话收到');
  if (command.type === 'set_session_name') out({ type: 'session_info_changed', name: command.name });
}).on('close', () => { trace({ kind: 'close' }); clearTimeout(timer); });
process.on('SIGTERM', () => { trace({ kind: 'term' }); process.exit(0); });
