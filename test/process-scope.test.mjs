import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessScope, minimalEnv } from '../scripts/process-scope.mjs';
const temporary=t=>{const dir=mkdtempSync(join(tmpdir(),'pi-process-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
async function until(fn) { for(let i=0;i<300;i++){if(fn())return;await delay(10);}throw new Error('fixture not ready'); }
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('timed-out command reaps a TERM-resistant descendant in its process group', async t => {
  const dir=temporary(t), scope=new ProcessScope(), pid=join(dir,'pid'), term=join(dir,'term');
  const script=`const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pid)},String(process.pid)); process.on('SIGTERM',()=>require('node:fs').writeFileSync(${JSON.stringify(term)},'TERM')); setInterval(()=>{},1000);`)}],{stdio:'inherit'});`;
  await assert.rejects(scope.run(process.execPath,['-e',script],{env:minimalEnv(dir),timeout:400}),/超时/);
  assert.ok(existsSync(term), 'TERM grace precedes KILL');
  const descendant=Number(readFileSync(pid));
  await until(()=>!alive(descendant));
  await scope.cleanup();
});

for (const signal of ['SIGINT','SIGTERM']) test(`scanner ${signal} cleans up its version subprocess and isolated HOME`, async t => {
  const dir=temporary(t), info=join(dir,'info'), fake=join(dir,'pi');
  writeFileSync(fake,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(info)},JSON.stringify({pid:process.pid,home:process.env.HOME})); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,{mode:0o755});
  const child=spawn(process.execPath,[resolve('scripts/check-pi-compat.mjs'),'--pi',fake,'--json'],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.resume();
  const exited=new Promise(resolve=>child.once('close',resolve));
  await until(()=>existsSync(info)); const recorded=JSON.parse(readFileSync(info));
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
