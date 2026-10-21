import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPi, PACKAGE } from "../agent/pi-command.mjs";
import { setup } from "../agent/setup.mjs";

const home = "/home/me", state = "/state/pi-plugin", node = "/coda/node/bin/node";
const npm = "/coda/node/lib/node_modules/npm/bin/npm-cli.js";

test("Pi is the path set in Coda, else on the PATH, else in the usual places, else the copy setup installed", () => {
  const find = (settings, usable) => findPi(settings, { env: { PATH: "/a:/b", CODA_PLUGIN_STATE: state }, home, usable: path => usable.includes(path) });
  assert.equal(find({ "pi.commandPath": "/opt/pi" }, []), "/opt/pi");
  assert.equal(find({}, ["/b/pi", join(home, ".local/bin/pi")]), "/b/pi", "a working pi later on the PATH is chosen over one that cannot run");
  assert.equal(find({ "pi.commandPath": "pi" }, [join(home, ".local/bin/pi"), join(state, "pi/bin/pi")]), join(home, ".local/bin/pi"));
  assert.equal(find({}, [join(state, "pi/bin/pi")]), join(state, "pi/bin/pi"));
  assert.equal(find({}, []), "pi");
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
  return { ran, said, options: { node, run, exists: path => path === npm, say: line => said.push(line), fail: line => said.push(`! ${line}`) } };
}

test("a Pi already here is used as it is; none, it is installed into the plugin's state with Coda's npm", () => {
  const env = { CODA_PLUGIN_STATE: state, CODA_PLUGIN_SETTINGS: "{}", PATH: "/usr/bin" };
  const own = machine({ "/usr/local/bin/pi": () => ({ status: 0, stdout: "1.2.0\n" }) });
  assert.equal(setup({ env, ...own.options, find: () => "/usr/local/bin/pi" }), 0);
  assert.deepEqual([own.ran, own.said], [[["/usr/local/bin/pi", "--version"]], ["已有 Pi 1.2.0：/usr/local/bin/pi"]]);

  let installed = false, path;
  const fresh = machine({
    [node]: (args, options) => { installed = true; path = options.env.PATH; return { status: 0 }; },
    [join(state, "pi/bin/pi")]: () => installed ? { status: 0, stdout: "1.3.0\n" } : { status: 1 },
  });
  assert.equal(setup({ env, ...fresh.options, find: () => "pi" }), 0);
  assert.deepEqual(fresh.ran, [[node, npm, "install", "--global", "--prefix", join(state, "pi"), "--no-fund", "--no-audit", "--no-update-notifier", PACKAGE],
    [join(state, "pi/bin/pi"), "--version"]]);
  assert.equal(path, "/coda/node/bin:/usr/bin", "npm and Pi run with Coda's Node first on the PATH");
  assert.equal(fresh.said.at(-1), `已安装 Pi 1.3.0：${join(state, "pi/bin/pi")}`);
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
  const managedPi = join(state, "pi/bin/pi");
  let repaired = false;
  const retry = machine({
    [managedPi]: () => repaired ? { status: 0, stdout: "1.3.0\n" } : { status: 1 },
    [node]: () => { repaired = true; return { status: 0 }; },
  });
  const env = { CODA_PLUGIN_STATE: state, CODA_PLUGIN_SETTINGS: "{}", PATH: "/usr/bin" };
  assert.equal(setup({ env, ...retry.options, find: () => managedPi }), 0);
  assert.deepEqual(retry.ran, [[managedPi, "--version"],
    [node, npm, "install", "--global", "--prefix", join(state, "pi"), "--no-fund", "--no-audit", "--no-update-notifier", PACKAGE],
    [managedPi, "--version"]]);
  assert.equal(retry.said.at(-1), `已安装 Pi 1.3.0：${managedPi}`);
});
