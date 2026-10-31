import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpc, piProcesses } from "../agent/pi-rpc.mjs";

test("PiRpc is active from spawn until close", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-lifecycle-"));
  const pi = join(dir, "pi");
  await writeFile(pi, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  await chmod(pi, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const rpc = new PiRpc({
    piCommand: pi,
    args: [],
    cwd: dir,
    env: process.env,
  });
  const before = piProcesses().length;
  const exited = rpc.waitForExit();
  rpc.spawn();
  assert.equal(piProcesses().length, before + 1);
  assert.equal(piProcesses().includes(rpc), true);
  rpc.kill("SIGTERM");
  await exited;
  assert.equal(rpc.exited, true);
  assert.equal(piProcesses().includes(rpc), false);
});

test("PiRpc runs a plugin-managed JavaScript entry through Node", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-managed-"));
  const cli = join(dir, "cli.js");
  await writeFile(cli, "setInterval(() => {}, 1000);\n");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const rpc = new PiRpc({
    piCommand: {
      command: process.execPath,
      prefixArgs: [cli],
      cliPath: cli,
      kind: "managed",
    },
    args: [],
    cwd: dir,
    env: process.env,
  });
  const exited = rpc.waitForExit();
  rpc.spawn();
  assert.equal(rpc.exited, false);
  rpc.kill("SIGTERM");
  await exited;
  assert.equal(rpc.exited, true);
});

test("a missing Pi is never registered as an active process", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-rpc-missing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = piProcesses().length;
  const rpc = new PiRpc({
    piCommand: join(dir, "missing-pi"),
    args: [],
    cwd: dir,
    env: process.env,
  });
  rpc.spawn();
  await rpc.waitForExit();
  assert.equal(piProcesses().length, before);
  assert.equal(rpc.exited, true);
});
