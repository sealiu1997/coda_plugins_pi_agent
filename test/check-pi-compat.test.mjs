import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, symlinkSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Writable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { declarations, members, splitTop, inspectPackage, compare, probe, checkProbe, parseArgs, changelogBetween, locatePackage, main, PROBE_COMMANDS } from '../scripts/check-pi-compat.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const surface = JSON.parse(readFileSync(join(root, 'compat/pi-surface.json')));
const source = Object.fromEntries(readdirSync(join(root, 'agent')).filter(p => p.endsWith('.mjs')).map(p => [`agent/${p}`, readFileSync(join(root, 'agent', p), 'utf8')]));
const uncomment = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const temporary = t => { const dir = mkdtempSync(join(tmpdir(), 'pi-compat-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const write = (dir, name, content) => { const path = join(dir, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; };

test('surface entries have real source evidence; every literal RPC send and CLI argument is inventoried', () => {
  for (const [category, deps] of Object.entries(surface.dependencies)) {
    assert.equal(new Set(deps.map(d => d.name)).size, deps.length);
    for (const dep of deps) for (const file of dep.sources) assert.ok(source[file]?.includes(dep.name), `${category} ${dep.name}: ${file}`);
  }
  for (const [file, text] of Object.entries(source)) {
    const code = uncomment(file === 'agent/setup.mjs' ? text.slice(0,text.indexOf('  const npm =')) : text);
    for (const m of code.matchAll(/\.send\(['"]([^'"]+)['"]/g)) assert.ok(surface.dependencies.commands.some(d => d.name === m[1] && d.sources.includes(file)), `${file}: ${m[1]}`);
    // Setup has no runtime lifecycle flags; its version check is centralized in pi-command.
    if (file === 'agent/setup.mjs') assert.match(code, /versionOf\(launch/);
    else for (const m of code.matchAll(/['"](--[\w-]+=?|-e=?)['"]/g)) assert.ok(surface.dependencies.cli.some(d => d.name === m[1] && d.sources.includes(file)), `${file}: ${m[1]}`);
    for (const m of code.matchAll(/pi\.(register\w+)\(/g)) assert.ok(surface.dependencies.extensionApi.some(d => d.name === m[1] && d.sources.includes(file)));
  }
});

test('all consumed event discriminants and response commands have surface entries', () => {
  const entry = source['agent/entry.mjs'];
  const events = entry.slice(entry.indexOf('function handlePiEvent'), entry.indexOf('function finishTurn'));
  for (const m of events.matchAll(/(?:record\.type\s*[!=]==\s*|case\s*)'([^']+)'/g)) assert.ok(surface.dependencies.events.some(d => d.name === m[1]), m[1]);
  for (const contract of surface.contracts) {
    assert.ok(contract.sources.length);
    for (const path of Object.keys(contract.fields)) {
      const field = path.split('.').pop();
      assert.ok(contract.sources.some(file => source[file]?.includes(field)), `${contract.symbol}.${path} has source evidence`);
    }
  }
  const consumed = [
    source['agent/entry.mjs'].slice(source['agent/entry.mjs'].indexOf('function handlePiEvent'), source['agent/entry.mjs'].indexOf('// ---- Tool kind mapping')),
    source['agent/entry.mjs'].slice(source['agent/entry.mjs'].indexOf('function handleExtensionUI'), source['agent/entry.mjs'].indexOf('// ---- Handle pi exit')),
    source['agent/compaction.mjs'], source['agent/pi-rpc.mjs'],
  ].join('\n');
  const knownFields = new Set(surface.contracts.flatMap(c => Object.keys(c.fields).flatMap(p => p.split('.'))));
  for (const m of consumed.matchAll(/record\??\.(\w+)/g)) assert.ok(knownFields.has(m[1]), `consumed record.${m[1]} must be inventoried`);
  for (const dep of surface.dependencies.commands.filter(d => d.name.startsWith('get_'))) assert.ok(surface.contracts.some(c => c.scope === 'response' && c.symbol === dep.name));
});

const types = `export type RpcCommand = {id?: string; type: "get_state";} | {id?: string; type: "prompt"; message: string; images?: ImageContent[];};
export type RpcResponse = {id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState;} | {id?: string; type: "response"; command: "prompt"; success: true; data: {disposition: string;};};
export interface RpcSessionState { model?: Model<any>; thinkingLevel: ThinkingLevel; }
export interface Model<A> extends BaseModel<A> { reasoning: boolean; }
interface BaseModel<A> { id: string; provider: string; }
type ThinkingLevel = "off" | "high";
export type RpcExtensionUIRequest = {type: "extension_ui_request"; method: "select"; options: string[];};`;
function fixture(t) {
  const dir = temporary(t);
  write(dir, 'package.json', JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.0.0' }));
  write(dir, 'dist/modes/rpc/rpc-types.d.ts', types);
  write(dir, 'dist/core/agent-session.d.ts', 'export type AgentSessionEvent = {type: "agent_settled"; aborted: boolean;};');
  write(dir, 'dist/core/extensions/types.d.ts', 'export interface ExtensionAPI {registerProvider(name: string, config: ProviderConfig): void;}');
  write(dir, 'dist/core/settings-manager.d.ts', 'export interface Settings { retry?: {enabled: boolean;}; }');
  write(dir, 'CHANGELOG.md', '## [1.0.0]\nnew\n## [0.9.0]\nold');
  return dir;
}
const help = 'Options:\n  --mode <mode>      Output\n  --no-session       Ephemeral\n  --extension, -e <path>   Extension\n';
const probeResults = () => Object.fromEntries(PROBE_COMMANDS.map(name => [name, {type:'response',command:name,success:true,data:{thinkingLevel:'off'}}]));
const minimal = { dependencies: {commands: [{name:'get_state',sources:['agent/entry.mjs']}], events:[], cli:[], extensionApi:[]}, contracts: [{scope:'response',symbol:'get_state',fields:{'data.model.id':'string','data.thinkingLevel':'string'},sources:['agent/entry.mjs'],optional:['data.model.id']}] };
function current(t) { return {...inspectPackage(fixture(t), help), version:'1.0.0'}; }
function baseline(c) { return {schemaVersion:1, version:c.version, reviewed:true, inventory:c.inventory, signatures:c.signatures}; }

test('declaration parser handles comments, nested objects, unions, generics, aliases and inheritance', t => {
  assert.deepEqual(splitTop('{a: string; b: number;} | string', '|'), ['{a: string; b: number;}', 'string']);
  assert.equal(members('{value?: Array<{id: string;}>; done: boolean;}').value.optional, true);
  const db = declarations({fixture: types}); assert.ok(db.get('Model').body.includes('BaseModel<A>'));
  const c = current(t), r = compare(minimal, c, baseline(c));
  assert.equal(r.incompatible.length, 0); assert.equal(r.review.length, 0);
  assert.ok(c.inventory.settings.includes('retry.enabled'));
  assert.ok(c.inventory.cli.includes('-e'));
});

test('removed command, renamed nested field, changed scalar and new required input are incompatible', t => {
  const c = current(t), b = baseline(c);
  c.inventory.commands = []; assert.ok(compare(minimal,c,b).incompatible.some(r => r.message.includes('get_state')));
  c.inventory.commands = ['get_state'];
  c.db.get('BaseModel').body = '{renamed: string; provider: string;}';
  assert.ok(compare(minimal,c,b).incompatible.some(r => r.message.includes('model.id')));
  c.db.get('BaseModel').body = '{id: number;}';
  assert.ok(compare(minimal,c,b).incompatible.some(r => r.message.includes('字段类型')));
  const enumSurface = {...minimal,values:[{symbol:'ThinkingLevel',values:['off','high'],sources:['x']}]};
  assert.equal(compare(enumSurface,c,b).incompatible.filter(r=>r.message.includes('枚举')).length,0);
  c.db.get('ThinkingLevel').body = '"off"';
  assert.ok(compare(enumSurface,c,b).incompatible.some(r=>r.message.includes('枚举缺失')));
  c.rpc.get_state[0].required = {type:'string',optional:false};
  assert.ok(compare(minimal,c,b).incompatible.some(r => r.message.includes('必填参数')));
});

test('inventory additions, version drift, unresolved any and declaration drift require review', t => {
  const c = current(t), b = structuredClone(baseline(c));
  c.inventory.commands.push('new_command'); c.version = '1.1.0';
  c.signatures.extensionApi.registerProvider += 'changed';
  const r = compare(minimal,c,b);
  assert.equal(r.incompatible.length, 0);
  assert.ok(r.review.some(r => r.message.includes('new_command')));
  assert.ok(r.review.some(r => r.message.includes('版本漂移')));
  assert.ok(r.review.some(r => r.message.includes('声明变化')));
  c.responses.get_state[0].data.type = 'any';
  assert.ok(compare(minimal,c,b).review.some(r => r.message.includes('无法解析字段')));
});

test('missing declarations fall back to docs at low confidence, never silently pass', t => {
  const dir = temporary(t); write(dir,'docs/rpc.md','{"type":"get_state"}');
  const c = {...inspectPackage(dir,''),version:'1.0.0'};
  assert.ok(c.unknown.length); assert.ok(c.evidence.commands.includes('低置信度'));
  assert.ok(compare(minimal,c,null).review.length);
});

test('extension overload and CLI value-shape changes are checked', t => {
  const c = current(t);
  const s = {...minimal,dependencies:{...minimal.dependencies,extensionApi:[{name:'registerProvider',sources:['x'],signature:'registerProvider(name: string, config: ProviderConfig): void'}],cli:[{name:'--mode',sources:['x'],takesValue:true}]}};
  assert.equal(compare(s,c,baseline(c)).incompatible.length,0);
  c.signatures.extensionApi.registerProvider = 'registerProvider(provider: Provider): void';
  c.signatures.cli['--mode'] = '';
  assert.equal(compare(s,c,baseline(c)).incompatible.length,2);
});

function fakeChild({hang = false, ignoreTerm = false, exitEarly = false, fail = false} = {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.requests = []; child.signals = []; let closed = false;
  child.stdin = new Writable({write(chunk, _, done) {
    const r = JSON.parse(chunk); child.requests.push(r);
    if (!hang) queueMicrotask(() => child.stdout.write(JSON.stringify({id:r.id,type:'response',command:r.type,success:!fail,data:{thinkingLevel:'off'}})+'\n'));
    done();
  }});
  child.kill = signal => {child.signals.push(signal); if (!closed && (!ignoreTerm || signal === 'SIGKILL')) {closed = true; queueMicrotask(() => child.emit('close',0,signal));} return true;};
  if (exitEarly) queueMicrotask(() => child.emit('close',1,null));
  return child;
}

test('probe sends only five fixed getters, uses isolated config/cwd and strips credentials', async t => {
  const dir = temporary(t), child = fakeChild(); let options, args;
  const results = await probe('/fake/node',join(dir,'probe'),{
    prefixArgs:['/plugin/pi/dist/bundle/cli.js'],
    spawnFn:(_,a,o) => {args=a;options=o;return child;},
    env:{PATH:'/bin',OPENAI_API_KEY:'never-forward',PI_CODING_AGENT_DIR:'/real',PI_CODING_AGENT_SESSION_DIR:'/real'},
  });
  assert.equal(Object.keys(results).length,5);
  assert.deepEqual(child.requests.map(r=>r.type),['get_state','get_commands','get_available_models','get_available_thinking_levels','get_session_stats']);
  assert.equal(args[0],'/plugin/pi/dist/bundle/cli.js');
  assert.ok(args.includes('--no-mcp')); assert.equal(options.env.PI_OFFLINE,'1'); assert.equal(options.env.PI_TELEMETRY,'0');
  assert.equal(options.env.OPENAI_API_KEY,undefined); assert.equal(options.env.HOME,options.cwd); assert.equal(options.env.PI_CODING_AGENT_DIR,options.cwd);
  assert.deepEqual(child.signals,['SIGTERM']);
});

test('probe timeout escalates TERM to KILL and waits for close', async t => {
  const child = fakeChild({hang:true,ignoreTerm:true});
  await assert.rejects(probe('/fake/pi',temporary(t),{spawnFn:()=>child,timeout:5}),/超时/);
  assert.deepEqual(child.signals,['SIGTERM','SIGKILL']);
});

test('probe early exit and spawn error reject and clean up', async t => {
  await assert.rejects(probe('/fake/pi',temporary(t),{spawnFn:()=>fakeChild({hang:true,exitEarly:true})}),/提前退出/);
  const child = fakeChild({hang:true});
  await assert.rejects(probe('/fake/pi',temporary(t),{spawnFn:()=>{queueMicrotask(()=>child.emit('error',new Error('ENOENT')));return child;}}),/ENOENT/);
  assert.deepEqual(child.signals,[], 'spawn error without a PID has no process to signal');
});

test('runtime field and envelope failures are incompatible; optional absent and empty arrays are valid', () => {
  assert.equal(checkProbe({get_state:{type:'response',command:'get_state',success:true,data:{thinkingLevel:'off'}}},minimal).failures.length,0);
  assert.ok(checkProbe({get_state:{type:'response',command:'get_state',success:true,data:{thinkingLevel:42}}},minimal).failures.length);
  assert.ok(checkProbe({get_state:{success:false}},minimal).failures.length);
});

test('arguments reject ambiguous or arbitrary npm specs; changelog excludes baseline', () => {
  assert.deepEqual(parseArgs(['--install','1.2.3-beta.1','--json']),{install:'1.2.3-beta.1',json:true});
  for (const args of [['--pi'],['--what'],['--install','git+https://x'],['--pi','x','--install','latest']]) assert.throws(()=>parseArgs(args));
  assert.equal(changelogBetween('## [1.1.0]\na\n## [1.0.0]\nb\n## [0.9.0]\nc','1.0.0','1.1.0'),'## [1.1.0]\na');
  assert.equal(changelogBetween('anything','1.0.0','1.0.0'),'');
});

test('package location follows npm symlinks and literal shell wrappers, rejects unknown binaries', t => {
  const dir = fixture(t), executable = write(dir,'dist/cli.js','#!/usr/bin/env node\n');
  const bin = join(dir,'bin'); mkdirSync(bin); symlinkSync(executable,join(bin,'pi'));
  assert.equal(locatePackage(join(bin,'pi')),realpathSync(dir));
  const wrapper = write(temporary(t),'pi',`#!/bin/sh\nexec ${executable} "$@"\n`);
  assert.equal(locatePackage(wrapper),realpathSync(dir));
  assert.throws(()=>locatePackage(write(temporary(t),'unknown','#!/bin/sh\nexit 0')),/无法/);
});

test('main never writes an unaccepted baseline; accept is explicit; ordinary runs preserve snapshot', async t => {
  const dir = fixture(t), snapshotPath = join(dir,'snapshot.json'), surfacePath = write(dir,'surface.json',JSON.stringify({...minimal,contracts:[]}));
  const executable = write(dir,'dist/cli.js',`#!${process.execPath}\nconsole.log('1.0.0');\n`);
  // piVersion invokes the fake binary; --help and probes use injected executors.
  const {chmodSync} = await import('node:fs'); chmodSync(executable,0o755);
  const opts = {snapshotPath,surfacePath,run:async(_,args)=>({stdout:args.includes('--version') ? '1.0.0' : help}),probeFn:async()=>probeResults()};
  const originalLog = console.log; const output = []; console.log = s=>output.push(s); t.after(()=>{console.log=originalLog;});
  assert.equal(await main(['--pi',executable,'--json'],opts),2);
  assert.equal(existsSync(snapshotPath),false);
  assert.equal(await main(['--pi',executable,'--json'],opts),2); assert.equal(existsSync(snapshotPath),false);
  assert.equal(await main(['--pi',executable,'--accept','--json'],opts),0);
  assert.equal(JSON.parse(readFileSync(snapshotPath)).reviewed,true);
  assert.equal(await main(['--pi',executable,'--json'],opts),0);
  assert.equal(JSON.parse(output.at(-1)).exitCode,0);
  const accepted = readFileSync(snapshotPath,'utf8');
  writeFileSync(surfacePath,JSON.stringify({...minimal,contracts:[{...minimal.contracts[0],fields:{'data.thinkingLevel':'number'}}]}));
  assert.equal(await main(['--pi',executable,'--accept','--json'],opts),1);
  assert.equal(readFileSync(snapshotPath,'utf8'),accepted);
  assert.equal(JSON.parse(output.at(-1)).exitCode,1);
  assert.equal(await main(['--install','latest','--json'],{...opts,run:async()=>{throw new Error('offline install failure');}}),3);
  assert.equal(JSON.parse(output.at(-1)).exitCode,3);
});


test('aliased enum values are resolved and new required extension fields fail', t => {
  const c = current(t);
  c.db.set('Alias', {body:'ThinkingLevel | "new"',file:'fixture'});
  const s = {...minimal,values:[{symbol:'Alias',values:['off','high'],sources:['x']}],contracts:[...minimal.contracts,{scope:'type',symbol:'Config',inputObject:true,fields:{existing:'string'},sources:['x']}]};
  c.db.set('Config',{body:'{existing: string; added: boolean;}',file:'fixture'});
  const r = compare(s,c,baseline(c));
  assert.equal(r.incompatible.length,1); assert.ok(r.incompatible[0].message.includes('新增必填字段'));
});

test('candidate install uses a temporary prefix and npm cache and removes them', async t => {
  const node = process.env.CODA_NODE || process.execPath;
  if (!existsSync(join(dirname(node),'../lib/node_modules/npm/bin/npm-cli.js'))) {t.skip('当前 Node 未附带 npm，检查器应报告退出码 3');return;}
  const template = fixture(t), state = temporary(t), surfacePath = write(state,'surface.json',JSON.stringify({...minimal,contracts:[]}));
  const snapshotPath = join(state,'snapshot.json'); let prefix, cache;
  const originalLog=console.log; console.log=()=>{}; t.after(()=>{console.log=originalLog;});
  const run = async (command,args,options) => {
    if (args.includes('install')) {
      assert.ok(args.includes('--ignore-scripts'));
      assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.CODA_PLUGIN_SECRETS, undefined);
      assert.equal(options.env.HOME, options.cwd);
      assert.equal(command,node); assert.equal(args[0],join(dirname(node),'../lib/node_modules/npm/bin/npm-cli.js'));
      prefix=args[args.indexOf('--prefix')+1]; cache=args[args.indexOf('--cache')+1];
      assert.ok(prefix.startsWith(options.cwd)); assert.ok(cache.startsWith(options.cwd));
      assert.equal(args.at(-1),'@earendil-works/pi-coding-agent@1.0.0');
      const pkg=join(prefix,'lib/node_modules/@earendil-works/pi-coding-agent'); cpSync(template,pkg,{recursive:true});
      const bin=write(pkg,'dist/cli.js',`#!${process.execPath}\nconsole.log('1.0.0');\n`);
      const {chmodSync}=await import('node:fs'); chmodSync(bin,0o755); mkdirSync(join(prefix,'bin')); symlinkSync(bin,join(prefix,'bin/pi'));
      return {stdout:''};
    }
    return {stdout:args.includes('--version') ? '1.0.0' : help};
  };
  assert.equal(await main(['--install','1.0.0','--json'],{run,snapshotPath,surfacePath,probeFn:async()=>probeResults()}),2);
  assert.equal(existsSync(prefix),false); assert.equal(existsSync(cache),false);
});

test('only a complete schema and reviewed === true can be a passing baseline', t => {
  const c = current(t), good = baseline(c);
  for (const reviewed of [false, undefined, null, 'true', 1, {}, []]) {
    assert.ok(compare(minimal, c, {...good, reviewed}).review.some(r => r.message.includes('尚无人确认')));
  }
  for (const broken of [{...good,schemaVersion:2},{...good,inventory:{}},{...good,signatures:{}},{...good,inventory:undefined}]) {
    assert.ok(compare(minimal,c,broken).review.some(r => r.message.includes('基线格式')));
  }
});

test('unparseable CLI signature (including CLAUDE help text), missing declarations and unknown types need review', t => {
  const c = current(t), b = structuredClone(baseline(c));
  const s = {...minimal,dependencies:{...minimal.dependencies,cli:[{name:'--mode',takesValue:true,sources:['x']}]}};
  delete c.signatures.cli['--mode'];
  assert.ok(compare(s,c,b).review.some(r => r.message.includes('CLI 签名')));
  c.responses.get_state = [];
  assert.ok(compare(s,c,b).review.some(r => r.message.includes('无法解析形状')));
  delete c.signatures.types.RpcSessionState;
  assert.ok(compare(s,c,b).review.some(r => r.message.includes('声明消失')));
  const docOnly = {...inspectPackage(fixture(t), '  --mode <mode>\n  --no-context-files CLAUDE.md\n'),version:'1.0.0'};
  assert.ok(compare(s,docOnly,b).review.some(r => r.message.includes('CLI 签名')));
});

test('every Pi transmission path and equals-form flag has a source contract', () => {
  const commands = new Set(surface.dependencies.commands.map(d=>d.name));
  for (const [file, text] of Object.entries(source)) {
    if (file === 'agent/pi-rpc.mjs') continue; // central serializer is checked below
    const code = uncomment(text);
    for (const call of code.matchAll(/\b(?:session\.)?pi\??\.(send|write)\(([^\n]+)/g)) {
      if (call[1] === 'send') {
        const name = call[2].match(/^['"]([^'"]+)['"]/)?.[1];
        assert.ok(commands.has(name), `${file}: unresolved send ${call[0]}`);
      } else {
        const literal = call[2].match(/^\{\s*type:\s*['"]([^'"]+)['"]/)?.[1];
        if (literal) assert.equal(literal, 'extension_ui_response');
        else assert.match(call[2], /^resp\)/); // every resp initializer below is inventoried
      }
    }
    for (const init of code.matchAll(/const resp = \{\s*type:\s*'([^']+)'/g)) assert.equal(init[1],'extension_ui_response');
    if (file !== 'agent/pi-rpc.mjs') assert.doesNotMatch(code, /(?:_child|child)\.stdin\.write/);
  }
  assert.equal((source['agent/pi-rpc.mjs'].match(/this\._child\.stdin\.write/g) ?? []).length,2);
  const contract = surface.contracts.find(c=>c.symbol==='RpcExtensionUIResponse');
  for (const field of ['type','id','cancelled','confirmed','value']) assert.ok(contract.fields[field]);
  for (const name of ['--extension','-e','--extension=','-e=']) assert.ok(surface.dependencies.cli.some(d=>d.name===name));
});

test('cleanup failure overrides incompatibility and never accepts or writes a baseline', async t => {
  const dir = fixture(t), snapshotPath=join(dir,'snapshot.json');
  const executable=write(dir,'dist/cli.js','not executed');
  const surfacePath=write(dir,'surface.json',JSON.stringify({...minimal,dependencies:{...minimal.dependencies,commands:[{name:'removed',sources:['x']}]}}));
  const logs=[]; const old=console.log; console.log=s=>logs.push(s); t.after(()=>{console.log=old;});
  const run=async(_,args)=>({stdout:args.includes('--version')?'1.0.0':help});
  assert.equal(await main(['--pi',executable,'--accept','--json'],{run,snapshotPath,surfacePath,probeFn:async()=>probeResults(),remove:path=>{t.after(()=>rmSync(path,{recursive:true,force:true}));throw new Error('denied cleanup');}}),3);
  assert.equal(existsSync(snapshotPath),false);
  assert.equal(JSON.parse(logs[0]).exitCode,3);
  assert.match(JSON.parse(logs[0]).error,/cleanup/);
});

test('missing probe replies cannot silently pass', async t => {
  const dir=fixture(t), executable=write(dir,'dist/cli.js','not executed');
  const surfacePath=write(dir,'surface.json',JSON.stringify({...minimal,contracts:[]}));
  const old=console.log; console.log=()=>{}; t.after(()=>{console.log=old;});
  assert.equal(await main(['--pi',executable,'--json'],{surfacePath,snapshotPath:join(dir,'snapshot.json'),run:async(_,args)=>({stdout:args.includes('--version')?'1.0.0':help}),probeFn:async()=>({})}),3);
});

test('accepting unresolved evidence cannot produce a green report', async t => {
  const dir=fixture(t),exe=write(dir,'dist/cli.js','fixture');
  const s={...minimal,contracts:[{...minimal.contracts[0],symbol:'UnresolvedRequiredType'}]};
  const surfacePath=write(dir,'surface.json',JSON.stringify(s)),snapshotPath=join(dir,'snapshot.json');
  const old=console.log,logs=[];console.log=s=>logs.push(s);t.after(()=>{console.log=old;});
  const options={surfacePath,snapshotPath,run:async(_,args)=>({stdout:args.includes('--version')?'1.0.0':help}),probeFn:async()=>probeResults()};
  assert.equal(await main(['--pi',exe,'--accept','--json'],options),2);
  assert.equal(JSON.parse(logs.at(-1)).baseline.reviewed,true);
  assert.equal(await main(['--pi',exe,'--json'],options),2);
});

test('unknown RPC success states and missing required nested values never pass', () => {
  for (const success of [undefined,null,'true',1,'unknown']) assert.ok(checkProbe({get_state:{type:'response',command:'get_state',success,data:{thinkingLevel:'off'}}},minimal).failures.length);
  assert.ok(checkProbe({get_state:{type:'response',command:'get_state',success:true,data:{}}},minimal).failures.length);
});


test('malformed JSON and null RPC output reject while still reaping the child', async t => {
  for (const output of ['null\n','[]\n','invalid json\n']) {
    const child=fakeChild({hang:true});
    child.stdin = new Writable({write(_,encoding,done) {queueMicrotask(()=>child.stdout.write(output));done();}});
    await assert.rejects(probe('/fake/pi',temporary(t),{spawnFn:()=>child}),/JSON|RPC/);
    assert.deepEqual(child.signals,['SIGTERM']);
  }
});
