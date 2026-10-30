import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPi, managedPi, PACKAGE, VERIFIED_PI_VERSION } from "../agent/pi-command.mjs";
import { setup } from "../agent/setup.mjs";

const home = "/home/me", state = "/state/pi-plugin", node = "/coda/node/bin/node";
const npm = "/coda/node/lib/node_modules/npm/bin/npm-cli.js";

test("Pi is the path set in Coda, else on the PATH, else in the usual places, else the copy setup installed", () => {
  const find = (settings, usable) => findPi(settings, { env: { PATH: "/a:/b", CODA_PLUGIN_STATE: state }, home, usable: path => usable.includes(path) });
  assert.equal(find({ "pi.commandPath": "/opt/pi" }, []), "/opt/pi");
  assert.equal(find({}, ["/b/pi", join(home, ".local/bin/pi")]), "/b/pi", "a working pi later on the PATH is chosen over one that cannot run");
  assert.equal(find({ "pi.commandPath": "pi" }, [join(home, ".local/bin/pi"), join(state, "pi/node_modules/.bin/pi")]), join(home, ".local/bin/pi"));
  assert.equal(find({}, [join(state, "pi/node_modules/.bin/pi")]), join(state, "pi/node_modules/.bin/pi"));
  assert.equal(find({}, []), "pi");
});

test("the plugin's own Pi is one path, the one the finder picks and setup installs over", () => {
  const env = { PATH: "/usr/bin", CODA_PLUGIN_STATE: state }, own = join(state, "pi/node_modules/.bin/pi");
  assert.equal(managedPi(env), own);
  assert.equal(managedPi({}), null, "a backend without a plugin state has no Pi of its own");
  assert.equal(findPi({}, { env, home, usable: path => path === own }), own);
});

test("a pi file on the PATH that cannot run is skipped", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const brokenDir = join(dir, "broken"), workingDir = join(dir, "working");
  await mkdir(brokenDir);
  await mkdir(workingDir);
  const broken = join(brokenDir, "pi"), working = join(workingDir, "pi");
  await writeFile(broken, "#!/bin/sh\n");
  await writeFile(working, "#!/bin/sh\necho 1.2.3\n");
  await chmod(working, 0o755);
  assert.equal(findPi({}, { env: { PATH: `${brokenDir}:${workingDir}` }, home: dir }), working);
});

// A machine whose commands answer as `answers` says: by command, its exit status and output.
function machine(answers) {
  const ran = [], said = [];
  const run = (command, args, options) => {
    ran.push([command, ...args]);
    const answer = answers[command]?.(args, options) ?? { status: null, error: new Error("ENOENT") };
    return { stdout: "", ...answer };
  };
  return { ran, said, options: { node, run, prepare: () => {}, exists: path => path === npm, say: line => said.push(line), fail: line => said.push(`! ${line}`) } };
}

test("a Pi already here is used as it is; none, it is installed into the plugin's state with Coda's npm", () => {
  const env = { CODA_PLUGIN_STATE: state, CODA_PLUGIN_SETTINGS: "{}", PATH: "/usr/bin" };
  const own = machine({ "/usr/local/bin/pi": () => ({ status: 0, stdout: "pi 1.2.0 (verified)\n" }) });
  assert.equal(setup({ env, ...own.options, find: () => "/usr/local/bin/pi" }), 0);
  assert.deepEqual([own.ran, own.said], [[["/usr/local/bin/pi", "--version"]], ["已有 Pi 1.2.0：/usr/local/bin/pi"]]);

  let installed = false, path;
  const fresh = machine({
    [node]: (args, options) => { installed = true; path = options.env.PATH; return { status: 0 }; },
    [join(state, "pi/node_modules/.bin/pi")]: () => installed ? { status: 0, stdout: "1.3.0\n" } : { status: 1 },
  });
  assert.equal(setup({ env, ...fresh.options, find: () => "pi" }), 0);
  assert.deepEqual(fresh.ran, [[node, npm, "ci", "--cache", join(state, "pi/npm-cache"), "--no-fund", "--no-audit", "--no-update-notifier", "--ignore-scripts"],
    [join(state, "pi/node_modules/.bin/pi"), "--version"]]);
  assert.equal(path, "/coda/node/bin:/usr/bin", "npm and Pi run with Coda's Node first on the PATH");
  assert.equal(fresh.said.at(-1), `已安装 Pi 1.3.0：${join(state, "pi/node_modules/.bin/pi")}`);
});

test("a path set in Coda that does not run is said, not installed over; a failed install says so last", () => {
  const broken = machine({});
  const env = { CODA_PLUGIN_STATE: state, CODA_PLUGIN_SETTINGS: JSON.stringify({ "pi.commandPath": "/opt/pi" }) };
  assert.equal(setup({ env, ...broken.options }), 1);
  assert.deepEqual([broken.ran, broken.said], [[["/opt/pi", "--version"]], ["! 设置里的 Pi 路径 /opt/pi 运行不了：改正它，或改回 pi 由插件安装"]]);

  const offline = machine({ [node]: () => ({ status: 1 }) });
  assert.equal(setup({ env: { CODA_PLUGIN_STATE: state }, ...offline.options, find: () => "pi" }), 1);
  assert.match(offline.said.at(-1), /^! 安装 Pi 失败（npm 退出码 1）/);

  const stateless = machine({});
  assert.equal(setup({ env: {}, ...stateless.options, find: () => "pi" }), 1);
  assert.match(stateless.said.at(-1), /没有插件状态目录/);
});

test("a Pi found on the machine that fails --version is said, not installed over", () => {
  const found = "/usr/local/bin/pi";
  const broken = machine({ [found]: () => ({ status: 1 }) });
  const env = { CODA_PLUGIN_STATE: state, CODA_PLUGIN_SETTINGS: "{}", PATH: "/usr/bin" };
  assert.equal(setup({ env, ...broken.options, find: () => found }), 1);
  assert.deepEqual(broken.ran, [[found, "--version"]], "the broken Pi blocks setup before npm is run");
  assert.match(broken.said.at(-1), /^! 找到的 Pi \/usr\/local\/bin\/pi 运行不了/);
});

test("the plugin's own Pi that fails --version is installed over", () => {
  const own = join(state, "pi/node_modules/.bin/pi");
  let repaired = false;
  const retry = machine({
    [own]: () => repaired ? { status: 0, stdout: "1.3.0\n" } : { status: 1 },
    [node]: () => { repaired = true; return { status: 0 }; },
  });
  const env = { CODA_PLUGIN_STATE: state, CODA_PLUGIN_SETTINGS: "{}", PATH: "/usr/bin" };
  assert.equal(setup({ env, ...retry.options, find: () => own }), 0);
  assert.deepEqual(retry.ran, [[own, "--version"],
    [node, npm, "ci", "--cache", join(state, "pi/npm-cache"), "--no-fund", "--no-audit", "--no-update-notifier", "--ignore-scripts"],
    [own, "--version"]]);
  assert.equal(retry.said.at(-1), `已安装 Pi 1.3.0：${own}`);
});

test('minimum, verified installer, snapshot and stable CI script agree', async () => {
  const { MIN_PI_VERSION, VERIFIED_PI_VERSION } = await import('../agent/pi-command.mjs');
  const { readFile } = await import('node:fs/promises');
  const baseline=JSON.parse(await readFile(new URL('../compat/pi-snapshot.json',import.meta.url)));
  const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url)));
  assert.equal(MIN_PI_VERSION,VERIFIED_PI_VERSION);
  assert.equal(baseline.version,MIN_PI_VERSION); assert.equal(baseline.reviewed,true);
  assert.equal(manifest.scripts['check:pi:verified'],`node scripts/check-pi-compat.mjs --install ${VERIFIED_PI_VERSION}`);
  assert.equal(manifest.devDependencies['@coda-console/plugin-check'],'0.5.8');
});

test('old and unknown external or explicitly configured Pi never trigger npm', () => {
  const own=join(state,'pi/node_modules/.bin/pi');
  for (const version of ['1.0.9','unknown','1.1.0-beta.1']) for (const path of ['/external/pi',own]) {
    const env={CODA_PLUGIN_STATE:state,CODA_PLUGIN_SETTINGS:JSON.stringify({'pi.commandPath':path})};
    const m=machine({[path]:()=>({status:0,stdout:version})});
    assert.equal(setup({env,...m.options}),1);
    assert.equal(m.ran.length,1); assert.match(m.said.at(-1),/最低版本 1.1.0/);
  }
});

test('old managed Pi upgrades to verified version; usable managed Pi is preserved', () => {
  const own=join(state,'pi/node_modules/.bin/pi'),env={CODA_PLUGIN_STATE:state}; let installed=false;
  const m=machine({[own]:()=>({status:0,stdout:installed?'1.1.0':'0.9.0'}),[node]:()=>{installed=true;return {status:0};}});
  assert.equal(setup({env,...m.options,find:()=>own}),0);
  assert.ok(m.ran[1].includes('ci')); assert.ok(m.ran[1].includes('--ignore-scripts'));
  const recent=machine({[own]:()=>({status:0,stdout:'2.0.0'})});
  assert.equal(setup({env,...recent.options,find:()=>own}),0); assert.equal(recent.ran.length,1);
});

test('latest upgrade is explicit and confined to managed Pi; bad post-install version fails', () => {
  const own=join(state,'pi/node_modules/.bin/pi'),env={CODA_PLUGIN_STATE:state};
  const m=machine({[own]:()=>({status:0,stdout:'1.1.0'}),[node]:()=>({status:0})});
  assert.equal(setup({env,...m.options,find:()=>own,upgradeLatest:true}),0);
  assert.ok(m.ran[1].includes('install'));
  const external=machine({'/external/pi':()=>({status:0,stdout:'1.2.0'})});
  assert.equal(setup({env,...external.options,find:()=>'/external/pi',upgradeLatest:true}),0); assert.equal(external.ran.length,1);
  const bad=machine({[own]:()=>({status:0,stdout:'0.9.0'}),[node]:()=>({status:0})});
  assert.equal(setup({env,...bad.options,find:()=>own}),1);
});

test('bundled verified npm graph is exact and preparation keeps latest opt-in isolated', async t => {
  const { readFile }=await import('node:fs/promises');
  const { prepareRuntime }=await import('../agent/pi-install.mjs');
  const manifest=JSON.parse(await readFile(new URL('../agent/pi-install/package.json',import.meta.url)));
  const lock=JSON.parse(await readFile(new URL('../agent/pi-install/package-lock.json',import.meta.url)));
  assert.equal(manifest.dependencies[PACKAGE],VERIFIED_PI_VERSION);
  assert.equal(lock.packages[''].dependencies[PACKAGE],VERIFIED_PI_VERSION);
  for (const [name,version] of Object.entries(manifest.overrides)) { assert.equal(version,VERIFIED_PI_VERSION); assert.equal(lock.packages[`node_modules/${name}`].version,version); }
  const dir=await mkdtemp(join(tmpdir(),'pi-prepare-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  prepareRuntime(dir);
  assert.equal(JSON.parse(await readFile(join(dir,'package-lock.json'))).lockfileVersion,3);
  prepareRuntime(dir,true);
  assert.deepEqual(JSON.parse(await readFile(join(dir,'package.json'))).dependencies,{[PACKAGE]:'latest'});
  await assert.rejects(readFile(join(dir,'package-lock.json')),/ENOENT/);
  prepareRuntime(dir);
  assert.equal(JSON.parse(await readFile(join(dir,'package.json'))).dependencies[PACKAGE],VERIFIED_PI_VERSION);
});

test('legacy managed Pi stays usable; a broken explicitly configured managed path is never overwritten', async () => {
  const { legacyManagedPi }=await import('../agent/pi-command.mjs');
  const env={CODA_PLUGIN_STATE:state},legacy=legacyManagedPi(env);
  const m=machine({[legacy]:()=>({status:0,stdout:'1.1.0'})});
  assert.equal(setup({env,...m.options,find:()=>legacy}),0); assert.equal(m.ran.length,1);
  const own=managedPi(env), broken=machine({});
  assert.equal(setup({env:{...env,CODA_PLUGIN_SETTINGS:JSON.stringify({'pi.commandPath':own})},...broken.options}),1);
  assert.equal(broken.ran.length,1);
});
