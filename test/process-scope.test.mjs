import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessScope, minimalEnv } from '../scripts/process-scope.mjs';
const temporary=t=>{const dir=mkdtempSync(join(tmpdir(),'pi-process-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
async function until(fn, description) {
  const timeout = 10_000, deadline = performance.now() + timeout;
  while (!fn()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`等待超时（${timeout}ms）：${description}`);
    await delay(Math.min(25, remaining));
  }
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

// The descendant resists TERM and reports its pid only after its handler is in place, so stopping
// is triggered once it is ready, however long Node takes to start.
function termResistantTree(dir) {
  const pid=join(dir,'pid'), term=join(dir,'term');
  const descendant=`process.on('SIGTERM',()=>require('node:fs').writeFileSync(${JSON.stringify(term)},'TERM')); require('node:fs').writeFileSync(${JSON.stringify(pid)},String(process.pid)); setInterval(()=>{},1000);`;
  return { pid, term, script:`const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});` };
}

test('stopping a command TERMs its process group, then KILLs a TERM-resistant descendant', async t => {
  const dir=temporary(t), scope=new ProcessScope(), tree=termResistantTree(dir);
  t.after(()=>scope.cleanup());
  const running=scope.run(process.execPath,['-e',tree.script],{env:minimalEnv(dir),timeout:60_000});
  const stopped=assert.rejects(running,/测试停止/);
  await until(()=>existsSync(tree.pid), `后代进程写出 ${tree.pid}`);
  const descendant=Number(readFileSync(tree.pid));
  scope.controller.abort(new Error('测试停止'));
  await stopped;
  assert.equal(readFileSync(tree.term,'utf8'), 'TERM', 'TERM grace precedes KILL');
  await until(()=>!alive(descendant), `Pi 后代进程 ${descendant} 退出`);
  assert.equal(scope.children.size,0);
});

test('a timed-out command is rejected and its whole process group is reaped', async t => {
  const dir=temporary(t), scope=new ProcessScope(), tree=termResistantTree(dir);
  t.after(()=>scope.cleanup());
  await assert.rejects(scope.run(process.execPath,['-e',tree.script],{env:minimalEnv(dir),timeout:100}),/超时/);
  assert.equal(scope.children.size,0);
  // Whether or not the descendant had started by then, none outlives the scope's KILL.
  if (existsSync(tree.pid)) await until(()=>!alive(Number(readFileSync(tree.pid))), '后代进程退出');
});

for (const signal of ['SIGINT','SIGTERM']) test(`scanner ${signal} cleans up its version subprocess and isolated HOME`, async t => {
  const dir=temporary(t), info=join(dir,'info'), fake=join(dir,'pi');
  writeFileSync(fake,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(info)},JSON.stringify({pid:process.pid,home:process.env.HOME})); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,{mode:0o755});
  const child=spawn(process.execPath,[resolve('scripts/check-pi-compat.mjs'),'--pi',fake,'--json'],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.resume();
  const exited=new Promise(resolve=>child.once('close',resolve));
  await until(()=>existsSync(info), `scanner ${signal} 的 Pi --version 就绪信息写入 ${info}`); const recorded=JSON.parse(readFileSync(info));
  child.kill(signal);assert.equal(await exited,3);
  assert.match(JSON.parse(stdout).error,/中断/);
  assert.equal(existsSync(recorded.home),false); assert.equal(alive(recorded.pid),false);
});

test('spawn failure is bounded and removes tracking', async () => {
  const scope=new ProcessScope();
  await assert.rejects(scope.run('/nonexistent/coda-test-executable',[]),/ENOENT/);
  await scope.cleanup(); assert.equal(scope.children.size,0);
});

test('output overflow kills the process and is an inspection error', async t => {
  const scope=new ProcessScope(),dir=temporary(t);
  await assert.rejects(scope.run(process.execPath,['-e','process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)'],{env:minimalEnv(dir),maxBuffer:100,timeout:3000}),/输出超限/);
  await scope.cleanup(); assert.equal(scope.children.size,0);
});

test('minimal install environment omits credentials, npm hooks, node injection and git helpers', () => {
  const env=minimalEnv('/isolated');
  for (const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','NPM_TOKEN','NODE_AUTH_TOKEN','CODA_PLUGIN_SECRETS','NODE_OPTIONS','NODE_PATH','NPM_CONFIG_SCRIPT_SHELL','GIT_CONFIG_GLOBAL','GIT_ASKPASS','SSH_AUTH_SOCK']) assert.equal(env[key],undefined,key);
  assert.equal(env.HOME,'/isolated'); assert.notEqual(env.NPM_CONFIG_USERCONFIG,env.NPM_CONFIG_GLOBALCONFIG);
});

test('real npm install cannot execute a lifecycle script with ignore-scripts', async t => {
  const { mkdirSync }=await import('node:fs');
  const { dirname }=await import('node:path');
  const dir=temporary(t),pkg=join(dir,'package'),target=join(dir,'target'),sentinel=join(dir,'executed');mkdirSync(pkg);mkdirSync(target);
  writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'fake-lifecycle-package',version:'1.0.0',scripts:{install:`node -e 'require("node:fs").writeFileSync(${JSON.stringify(sentinel)},"bad")'`}}));
  const node=process.env.CODA_NODE||process.execPath,npm=join(dirname(node),'../lib/node_modules/npm/bin/npm-cli.js'),scope=new ProcessScope();
  try {
    await scope.run(node,[npm,'install','--offline','--ignore-scripts','--install-links','--no-audit','--no-fund','--cache',join(dir,'cache'),pkg],{cwd:target,env:minimalEnv(dir),timeout:20000});
    assert.equal(existsSync(sentinel),false);
    assert.ok(existsSync(join(target,'node_modules/fake-lifecycle-package/package.json')));
  } finally { await scope.cleanup(); }
});

// A tracked child that is only a pid: process.kill is replaced so the group answers the way the test needs.
function fakeGroup(t, kill) {
  const child = Object.assign(new EventEmitter(), { pid: 424242 });
  const calls = [];
  t.mock.method(process, 'kill', (pid, signal) => { calls.push([pid, signal]); return kill(signal, calls); });
  const scope = new ProcessScope(), entry = scope.track(child, 60);
  return { child, calls, scope, entry };
}
const errno = code => Object.assign(new Error(`kill ${code}`), { code });

test('a process group that answers EPERM (macOS, only zombies left) is gone: signal ignores it, alive is false', t => {
  const { scope, entry, calls } = fakeGroup(t, () => { throw errno('EPERM'); });
  assert.doesNotThrow(() => scope.signal(entry, 'SIGTERM'));
  assert.doesNotThrow(() => scope.signal(entry, 'SIGKILL'));
  assert.equal(scope.alive(entry), false);
  assert.deepEqual(calls.map(([pid]) => pid), [-424242, -424242, -424242]);
});

test('ESRCH is still treated as gone, while other errors such as EINVAL are not swallowed', t => {
  const gone = fakeGroup(t, () => { throw errno('ESRCH'); });
  assert.doesNotThrow(() => gone.scope.signal(gone.entry, 'SIGTERM'));
  assert.equal(gone.scope.alive(gone.entry), false);
  t.mock.restoreAll();
  const bad = fakeGroup(t, () => { throw errno('EINVAL'); });
  assert.throws(() => bad.scope.signal(bad.entry, 'SIGTERM'), /进程组清理失败：kill EINVAL/);
  assert.throws(() => bad.scope.alive(bad.entry), /kill EINVAL/);
});

test('stop finishes TERM, wait, KILL cleanly when the group turns EPERM mid-way, and reports no failure', async t => {
  let killed = false;
  const { child, scope, entry, calls } = fakeGroup(t, signal => {
    if (signal === 'SIGKILL') { killed = true; setImmediate(() => child.emit('close', null, 'SIGKILL')); throw errno('EPERM'); }
    if (killed) throw errno('EPERM');
    return true; // TERM is delivered and the group stays alive until KILL
  });
  await scope.stop(entry);
  assert.deepEqual(calls.filter(([, s]) => s !== 0).map(([, s]) => s), ['SIGTERM', 'SIGKILL']);
  assert.equal(scope.children.size, 0);
  await assert.doesNotReject(scope.cleanup());

  // The group is already EPERM at the first TERM: no KILL is needed and cleanup still succeeds.
  t.mock.restoreAll();
  const early = fakeGroup(t, () => { throw errno('EPERM'); });
  setImmediate(() => early.child.emit('close', 0, null));
  await early.scope.stop(early.entry);
  assert.deepEqual(early.calls.filter(([, s]) => s !== 0).map(([, s]) => s), ['SIGTERM']);
  await assert.doesNotReject(early.scope.cleanup());
});

test('cleanup still fails the check when the group error is neither gone nor EPERM', async t => {
  const { scope } = fakeGroup(t, () => { throw errno('EINVAL'); });
  await assert.rejects(scope.cleanup(), /进程组清理失败：kill EINVAL/);
});
