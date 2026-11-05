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

test("piVersion retries after a transient version-check failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-retry-"));
  try {
    const pi = join(dir, "pi");
    await writeFile(pi, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.equal(await piVersion(pi), null);
    await writeFile(pi, "#!/bin/sh\necho 1.4.0\n", { mode: 0o755 });
    assert.equal(await piVersion(pi), "1.4.0");
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
  const { supportedVersion, assertPiVersion, MIN_PI_VERSION } = await import('../agent/pi-command.mjs');
  const [major, minor] = MIN_PI_VERSION.split('.').map(Number);
  const below = `${major}.${minor - 1}.99`;
  for (const value of [null,'?',below,'1.0.99',`${MIN_PI_VERSION}-beta.1`,'garbage']) {
    assert.equal(supportedVersion(value),false);
    assert.throws(()=>assertPiVersion(value,'/external/pi'),new RegExp(`最低版本 ${MIN_PI_VERSION.replaceAll('.', '\\.')}.*跟随最新版.*原来的安装工具升级`,'s'));
  }
  for (const value of [MIN_PI_VERSION,`${major}.${minor}.1`,`${major}.${minor + 6}.0`,`${major + 1}.0.0`,`${MIN_PI_VERSION}+build`]) assert.equal(supportedVersion(value),true);
});

test('the floor is the first release of the plugin\'s Pi series and never below the shipped 1.1.0', async () => {
  const { MIN_PI_VERSION, PI_SERIES, FALLBACK_PI_SERIES } = await import('../agent/pi-command.mjs');
  assert.equal(MIN_PI_VERSION, `${PI_SERIES}.0`);
  const [major, minor] = PI_SERIES.split('.').map(Number);
  assert.ok(major > 1 || (major === 1 && minor >= 1));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const declared = /^(\d+\.\d+)\.\d+$/.exec(manifest.version)[1];
  assert.equal(PI_SERIES, declared.split('.')[0] === '0' ? FALLBACK_PI_SERIES : declared);
});

test('the Pi series is read from the plugin manifest, with an explicit fallback when it cannot be', async () => {
  const { readPiSeries, FALLBACK_PI_SERIES } = await import('../agent/pi-command.mjs');
  const manifest = version => ({ read: () => JSON.stringify({ version }) });
  assert.equal(readPiSeries(manifest('1.5.0')), '1.5');
  assert.equal(readPiSeries(manifest('1.5.7')), '1.5');
  assert.equal(readPiSeries(manifest('1.12.3')), '1.12');
  assert.equal(readPiSeries(manifest('2.0.1')), '2.0');
  assert.equal(readPiSeries(manifest('1.5.0-beta.1')), '1.5');
  // Below the 1.1 floor the plugin version is not a Pi series (0.x plugins predate this scheme).
  for (const version of ['0.5.1', '1.0.9']) assert.equal(readPiSeries(manifest(version)), FALLBACK_PI_SERIES);
  // Unreadable, malformed or missing versions fall back rather than throw.
  assert.equal(readPiSeries({ read: () => { throw new Error('ENOENT'); } }), FALLBACK_PI_SERIES);
  assert.equal(readPiSeries({ read: () => 'not json' }), FALLBACK_PI_SERIES);
  assert.equal(readPiSeries({ read: () => '{}' }), FALLBACK_PI_SERIES);
  for (const version of [null, 15, '1.5', 'x.y.z', '']) assert.equal(readPiSeries(manifest(version)), FALLBACK_PI_SERIES);
  // The default reader finds this repository's own package.json.
  assert.match(readPiSeries(), /^\d+\.\d+$/);
  const dir = await mkdtemp(join(tmpdir(), 'pi-series-'));
  try {
    assert.equal(readPiSeries({ url: join(dir, 'missing.json') }), FALLBACK_PI_SERIES);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ version: '1.7.2' }));
    assert.equal(readPiSeries({ url: join(dir, 'package.json') }), '1.7');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Pi versions are classified against a series as unsupported, verified or unverified', async () => {
  const { piVersionStatus, unverifiedNotice, PI_SERIES } = await import('../agent/pi-command.mjs');
  const status = (version, series = '1.5') => piVersionStatus(version, series);
  for (const version of ['1.4.9', '1.0.0', '0.9.0', '1.4.99+build']) assert.equal(status(version), 'unsupported', version);
  for (const version of [null, undefined, '', 'garbage', '1.5', '1.5.0-beta.1', '1.6.0-rc.1']) assert.equal(status(version), 'unsupported', String(version));
  for (const version of ['1.5.0', '1.5.1', '1.5.12', '1.5.0+build']) assert.equal(status(version), 'verified', version);
  for (const version of ['1.6.0', '1.10.0', '1.99.9', '2.0.0', '3.1.4']) assert.equal(status(version), 'unverified', version);
  assert.equal(status('1.5.3', '1.4'), 'unverified');
  assert.equal(status('1.4.0', '1.4'), 'verified');
  assert.equal(status('3.0.0', '2.9'), 'unverified');
  const [major, minor] = PI_SERIES.split('.').map(Number);
  assert.equal(unverifiedNotice(`${PI_SERIES}.2`), null);
  assert.equal(unverifiedNotice(`${major}.${minor - 1}.0`), null);
  assert.match(unverifiedNotice(`${major}.${minor + 1}.0`), new RegExp(`^Pi ${major}\\.${minor + 1}\\.0 高于本插件验证过的 ${major}\\.${minor} 系列，仍可使用但尚未验证；建议在插件页更新 Pi 插件。$`));
});
