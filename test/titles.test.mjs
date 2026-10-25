import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { titleMaterial, generateTitle } from "../agent/titles.mjs";
import { envForPi } from "../agent/pi-env.mjs";

test("title material is the first prompt and reply, cut short; null when there is too little to name", () => {
  assert.equal(titleMaterial(null, null), null);
  assert.equal(titleMaterial([{ type: "text", text: "hi" }], null), null, "a prompt too short says nothing");
  const dialogue = titleMaterial(
    [{ type: "text", text: "看一下怎么把这个插件打包" }, { type: "image", data: "xx" }],
    [{ type: "text", text: "已经发布。" }],
  );
  assert.match(dialogue, /^用户：看一下怎么把这个插件打包\n回复：已经发布。$/);
  const long = "字".repeat(800);
  assert.match(titleMaterial([{ type: "text", text: long }], [{ type: "text", text: long }]), /…$/);
  assert.ok(titleMaterial([{ type: "text", text: long }], null).length < 700, "only the prompt's cut counts");
});

// A pi stand-in: writes its stdout, after the delay a model answer takes; killed scripts die silent.
async function scriptPi(t, body, mode = 0o755) {
  const dir = await mkdtemp(join(tmpdir(), "pi-title-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "pi");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode });
  return path;
}

test("a title is the child's answer, tidied; failures and silence resolve null", async t => {
  const say = body => scriptPi(t, body);
  assert.equal(await generateTitle(await say("echo '  “插件打包”  '"), "/tmp", null, "用户：打包插件\n回复：已发布", {}), "插件打包");
  assert.equal(await generateTitle(await say("echo '简短标题。'"), "/tmp", "magpie/x", "用户：打包插件", {}), "简短标题。");
  assert.equal(await generateTitle(await say("exit 1"), "/tmp", null, "用户：打包插件", {}), null, "a failed child names nothing");
  assert.equal(await generateTitle(await say("sleep 60"), "/tmp", null, "用户：打包插件", { timeout: 150 }), null, "a slow child is given up on");
  assert.equal(await generateTitle(await say("echo ''"), "/tmp", null, "用户：打包插件", {}), null, "an empty answer names nothing");
  assert.equal(await generateTitle("/no/such/pi", "/tmp", null, "用户：打包插件", {}), null, "a missing pi names nothing");
  assert.equal(await generateTitle(await say("echo x"), "/tmp", null, null, {}), null, "nothing to name");
});

test("the title child is asked without a session, tools, or extensions, on the session's model", async t => {
  const seen = [];
  const spawnFn = (command, args) => {
    seen.push(args);
    return { stdout: { on: () => {}, destroy: () => {} }, on: () => {}, kill: () => {} };
  };
  await generateTitle("/bin/pi", "/tmp", "magpie/auto/x", "用户：打包插件", { spawnFn, timeout: 100 });
  const args = seen[0];
  assert.ok(args.slice(0, 8).every(a => ['--print', '--mode', 'text', '--no-session', '--no-tools', '--no-extensions', '--no-mcp', '--no-skills'].includes(a)));
  assert.deepEqual(args.filter((a, i) => args[i - 1] === '--model'), ["magpie/auto/x"]);
  assert.match(args.at(-1), /^用一句话/);
});

test("a pi outside the PATH and Coda's node dir are both prepended, each once", () => {
  const env = envForPi({ PATH: "/usr/bin:/bin" }, "/opt/pi/bin/pi", "/coda/node/bin/node");
  assert.equal(env.PATH, "/coda/node/bin:/opt/pi/bin:/usr/bin:/bin");
  assert.equal(envForPi({ PATH: "/x" }, "pi", "/coda/node/bin/node").PATH, "/coda/node/bin:/x");
  // A directory already on the PATH is not added twice.
  assert.equal(envForPi({ PATH: "/p:/a" }, "/p/pi", "/n/bin/node").PATH, "/n/bin:/p:/a");
  assert.equal(envForPi({ PATH: "/n:/p:/a" }, "/p/pi", "/n/bin/node").PATH, "/n/bin:/n:/p:/a");
});
