import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piVersion } from "../agent/pi-command.mjs";

async function scriptPi(dir, body) {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const path = join(bin, "pi");
  await writeFile(path, "#!/bin/sh\n" + body, { mode: 0o755 });
  return path;
}

test("piVersion reads the binary's own version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const pi = await scriptPi(dir, "echo 1.1.0\n");
    assert.equal(await piVersion(pi), "1.1.0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion takes the bare version out of decorated output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const pi = await scriptPi(dir, "echo 'pi 2.3.1 (abc123)'\n");
    assert.equal(await piVersion(pi), "2.3.1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion falls back when the binary cannot run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const pi = await scriptPi(dir, "exit 1\n");
    assert.equal(await piVersion(pi, { fallback: () => "0.2.1" }), "0.2.1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion falls back when the binary is not executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const path = join(dir, "pi");
    await writeFile(path, "#!/bin/sh\necho 1.0.0\n", { mode: 0o644 });
    assert.equal(await piVersion(path, { fallback: () => "0.2.1" }), "0.2.1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion caches per command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const pi = await scriptPi(dir, "echo 3.0.0\n");
    assert.equal(await piVersion(pi), "3.0.0");
    await chmod(pi, 0o000);
    assert.equal(await piVersion(pi, { fallback: () => "stale" }), "3.0.0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion runs a plugin-managed launch through CODA_NODE", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-managed-"));
  try {
    const cli = join(dir, "cli.js");
    await writeFile(cli, "console.log('1.4.0');\n");
    assert.equal(await piVersion({
      command: process.execPath,
      prefixArgs: [cli],
      cliPath: cli,
      kind: "managed",
    }), "1.4.0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion finds node through the injected PATH for an absolute Pi command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-path-"));
  try {
    const nodeDir = join(dir, "node-bin");
    const piDir = join(dir, "pi-bin");
    await mkdir(nodeDir);
    await mkdir(piDir);
    await symlink(process.execPath, join(nodeDir, "node"));
    const pi = join(piDir, "pi");
    await writeFile(pi, "#!/usr/bin/env node\nconsole.log('1.4.0');\n", { mode: 0o755 });
    assert.equal(await piVersion(pi, {
      env: { PATH: nodeDir },
      node: join(nodeDir, "node"),
    }), "1.4.0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the plugin version fallback ends at 'unknown' when package.json cannot be read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const pi = await scriptPi(dir, "exit 1\n");
    // Mirrors entry.mjs' pluginVersion(): read, parse, and fall through to 'unknown' when either fails.
    const pluginVersion = async pluginPath => {
      try { return JSON.parse(await readFile(join(pluginPath, "package.json"), "utf8")).version ?? "unknown"; }
      catch { return "unknown"; }
    };
    assert.equal(await pluginVersion(join(dir, "no-such-plugin")), "unknown");
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
    assert.equal(await pluginVersion(dir), "9.9.9");
    // piVersion with a failing command resolves through the fallback instead of throwing.
    assert.equal(await piVersion(pi, { fallback: () => pluginVersion(dir) }), "9.9.9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime version floor rejects old, unknown and prerelease versions with upgrade guidance', async () => {
  const { supportedVersion, assertPiVersion } = await import('../agent/pi-command.mjs');
  for (const value of [null,'?','1.0.99','1.1.0-beta.1','garbage']) {
    assert.equal(supportedVersion(value),false);
    assert.throws(()=>assertPiVersion(value,'/external/pi'),/最低版本 1.1.0.*跟随最新版.*原来的安装工具升级/s);
  }
  for (const value of ['1.1.0','1.1.1','1.10.0','2.0.0','1.1.0+build']) assert.equal(supportedVersion(value),true);
});
