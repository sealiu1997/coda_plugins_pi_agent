import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findPi,
  legacyManagedPi,
  managedPi,
  managedPrefix,
  PACKAGE,
  VERIFIED_PI_VERSION,
  resolvePiLaunch,
} from '../agent/pi-command.mjs';
import { RollbackError } from '../agent/pi-runtime.mjs';
import { setup } from '../agent/setup.mjs';

const home = '/home/me';
const state = '/state/pi-plugin';
const node = '/coda/node/bin/node';
const own = managedPi({}, home);
const npmActual = join(home, '.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');

function machine({
  versions = {},
  updateResult = { version: '1.4.0', path: own, installed: true },
  realpath = path => path,
} = {}) {
  const ran = [];
  const said = [];
  const updates = [];
  let updated = false;
  return {
    ran,
    said,
    updates,
    options: {
      node,
      run: (command, args) => {
        ran.push([command, ...args]);
        if (updated && command === updateResult.path) return { status: 0, stdout: `${updateResult.version}\n` };
        return versions[command]?.() ?? { status: null, error: new Error('ENOENT') };
      },
      update: options => {
        updates.push(options);
        if (updateResult instanceof Error) throw updateResult;
        updated = true;
        return updateResult;
      },
      realpath,
      say: line => said.push(line),
      fail: line => said.push(`! ${line}`),
    },
  };
}

test('Pi lookup uses explicit settings, PATH, common installs, managed ~/.local and the legacy state copy', () => {
  const find = (settings, usable, read = () => []) => findPi(settings, {
    env: { PATH: '/a:/b', CODA_PLUGIN_STATE: state },
    home,
    usable: path => usable.includes(path),
    read,
  });
  assert.equal(find({ 'pi.commandPath': '/opt/pi' }, []), '/opt/pi');
  assert.equal(find({}, ['/b/pi', own]), '/b/pi');
  assert.equal(find({ 'pi.commandPath': 'pi' }, [own]), own);
  assert.equal(find({}, [legacyManagedPi({ CODA_PLUGIN_STATE: state })]), legacyManagedPi({ CODA_PLUGIN_STATE: state }));
  assert.equal(find({}, []), 'pi');
});

test('Pi lookup also finds nvm, fnm and asdf installs when Coda did not inherit their PATH', () => {
  const nvm = join(home, '.nvm/versions/node');
  const fnm = join(home, '.local/share/fnm/node-versions');
  const requested = [];
  const read = (path) => {
    requested.push(path);
    if (path === nvm) return [{ name: 'v22.9.0', isDirectory: () => true }, { name: 'v22.10.0', isDirectory: () => true }];
    if (path === fnm) return [{ name: 'v24.1.0', isDirectory: () => true }];
    return [];
  };
  const nvmPi = join(nvm, 'v22.10.0/bin/pi');
  assert.equal(findPi({}, { env: {}, home, read, usable: path => path === nvmPi }), nvmPi);
  assert.ok(requested.includes(fnm));
});

test('Pi lookup finds an fnm install in its macOS data directory', () => {
  const fnm = join(home, 'Library/Application Support/fnm/node-versions');
  const read = path => path === fnm ? [{ name: 'v24.1.0', isDirectory: () => true }] : [];
  const fnmPi = join(fnm, 'v24.1.0/installation/bin/pi');
  assert.equal(findPi({}, { env: {}, home, read, usable: path => path === fnmPi }), fnmPi);
});

test('automatic launch resolution is the machine Pi rather than a plugin-private package', () => {
  assert.equal(resolvePiLaunch({}, {
    env: { PATH: '/usr/local/bin' },
    home,
    usable: path => path === '/usr/local/bin/pi',
  }), '/usr/local/bin/pi');
});

test('the managed runtime is a normal npm prefix at ~/.local', () => {
  assert.equal(managedPrefix({}, home), join(home, '.local'));
  assert.equal(managedPrefix({ CODA_PI_PREFIX: '/managed' }, home), '/managed');
  assert.equal(managedPi({}, home), join(home, '.local/bin/pi'));
  assert.equal(legacyManagedPi({ CODA_PLUGIN_STATE: state }), join(state, 'pi/bin/pi'));
});

test('a pi file on PATH that cannot execute is skipped', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const brokenDir = join(dir, 'broken');
  const workingDir = join(dir, 'working');
  await mkdir(brokenDir);
  await mkdir(workingDir);
  const broken = join(brokenDir, 'pi');
  const working = join(workingDir, 'pi');
  await writeFile(broken, '#!/bin/sh\n');
  await writeFile(working, '#!/bin/sh\necho 1.4.0\n');
  await chmod(working, 0o755);
  assert.equal(findPi({}, { env: { PATH: `${brokenDir}:${workingDir}` }, home: dir }), working);
});

test('an existing supported Pi is taken over without invoking npm', () => {
  const m = machine({ versions: { '/usr/local/bin/pi': () => ({ status: 0, stdout: 'pi 1.4.0\n' }) } });
  assert.equal(setup({ env: {}, home, ...m.options, find: () => '/usr/local/bin/pi' }), 0);
  assert.deepEqual(m.ran, [['/usr/local/bin/pi', '--version']]);
  assert.equal(m.updates.length, 0);
  assert.deepEqual(m.said, ['已有 Pi 1.4.0 可用：/usr/local/bin/pi']);
});

test('setup cleans a stale committed backup even when follow-latest is off', async t => {
  const runtimeHome = await mkdtemp(join(tmpdir(), 'pi-setup-recovery-'));
  t.after(() => rm(runtimeHome, { recursive: true, force: true }));
  const prefix = join(runtimeHome, '.local');
  const runtimeCommand = managedPi({}, runtimeHome);
  const runtimeActual = join(prefix, `lib/node_modules/${PACKAGE}/dist/bundle/cli.js`);
  const backup = join(prefix, '.coda-pi-backup-stale');
  const lock = join(prefix, '.coda-pi-update.lock');
  await mkdir(backup, { recursive: true });
  await mkdir(lock, { recursive: true });
  await writeFile(join(backup, 'transaction.json'), JSON.stringify({
    schemaVersion: 1,
    phase: 'committed',
    states: [],
  }));
  await writeFile(join(lock, 'owner-999999999-0f0f'), '');
  const m = machine({
    versions: { [runtimeCommand]: () => ({ status: 0, stdout: '1.4.0\n' }) },
    realpath: path => path === runtimeCommand ? runtimeActual : path,
  });

  assert.equal(setup({
    env: {},
    home: runtimeHome,
    ...m.options,
    find: () => runtimeCommand,
  }), 0);
  await assert.rejects(stat(backup), error => error.code === 'ENOENT');
  await assert.rejects(stat(lock), error => error.code === 'ENOENT');
  assert.deepEqual(m.said, [`已有 Pi 1.4.0 可用：${runtimeCommand}`]);
});

test('a missing Pi installs npm latest into ~/.local/bin', () => {
  const m = machine();
  assert.equal(setup({ env: {}, home, ...m.options, find: () => m.updates.length ? own : 'pi' }), 0);
  assert.equal(m.updates.length, 1);
  assert.equal(m.said[0], `安装 Pi latest 到 ${own}`);
  assert.equal(m.said.at(-1), `已安装 Pi 1.4.0：${own}`);
});

test('an automatically discovered npm copy below the minimum is upgraded in place', () => {
  const m = machine({
    versions: { [own]: () => ({ status: 0, stdout: '1.0.9\n' }) },
    realpath: path => path === own ? npmActual : path,
  });
  assert.equal(setup({ env: {}, home, ...m.options, find: () => own }), 0);
  assert.equal(m.updates.length, 1);
  assert.equal(m.said.at(-1), `已升级到兼容版本 Pi 1.4.0：${own}`);
});

test('an explicit npm path is protected unless latest policy is enabled', () => {
  const old = machine({
    versions: { [own]: () => ({ status: 0, stdout: '1.0.9\n' }) },
    realpath: path => path === own ? npmActual : path,
  });
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.commandPath': own }) };
  assert.equal(setup({ env, home, ...old.options, find: () => own }), 1);
  assert.equal(old.updates.length, 0);
  assert.match(old.said.at(-1), /低于最低版本 1\.1\.0/);

  const latest = machine({
    versions: { [own]: () => ({ status: 0, stdout: '1.2.0\n' }) },
    realpath: path => path === own ? npmActual : path,
  });
  const latestEnv = {
    CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.commandPath': own, 'pi.updateLatest': true }),
  };
  assert.equal(setup({ env: latestEnv, home, ...latest.options, find: () => own }), 0);
  assert.equal(latest.updates.length, 1);
  assert.equal(latest.said.at(-1), `已更新到 Pi 1.4.0：${own}`);

  const tooOld = machine({
    versions: { [own]: () => ({ status: 0, stdout: '1.0.9\n' }) },
    realpath: path => path === own ? npmActual : path,
  });
  assert.equal(setup({ env: latestEnv, home, ...tooOld.options, find: () => own }), 0);
  assert.equal(tooOld.updates.length, 1);
  assert.equal(tooOld.said.at(-1), `已更新到 Pi 1.4.0：${own}`);
});

test('follow-latest updates a recognized npm global install in its own prefix', () => {
  const external = '/opt/homebrew/bin/pi';
  const m = machine({
    versions: { [external]: () => ({ status: 0, stdout: '1.2.0\n' }) },
    updateResult: { version: '1.4.0', path: external },
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  });
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.updateLatest': true }) };
  assert.equal(setup({ env, home, ...m.options, find: () => external }), 0);
  assert.equal(m.updates.length, 1);
  assert.equal(m.said.at(-1), `已更新到 Pi 1.4.0：${external}`);
});

test('follow-latest reports an already-current npm Pi without pretending to reinstall it', () => {
  const external = '/opt/homebrew/bin/pi';
  const m = machine({
    versions: { [external]: () => ({ status: 0, stdout: '1.4.0\n' }) },
    updateResult: { version: '1.4.0', path: external, installed: false, changed: false },
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  });
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.updateLatest': true }) };
  assert.equal(setup({ env, home, ...m.options, find: () => external }), 0);
  assert.equal(m.updates.length, 1);
  assert.equal(m.said.at(-1), `Pi 1.4.0 已是最新版本：${external}`);
});

test('custom installers are taken over but never overwritten or falsely reported as updatable', () => {
  const current = machine({ versions: { '/custom/pi': () => ({ status: 0, stdout: '1.4.0\n' }) } });
  assert.equal(setup({ env: {}, home, ...current.options, find: () => '/custom/pi' }), 0);
  assert.equal(current.updates.length, 0);

  for (const answer of [{ status: 0, stdout: '1.0.9\n' }, { status: 1 }]) {
    const external = machine({ versions: { '/custom/pi': () => answer } });
    assert.equal(setup({ env: {}, home, ...external.options, find: () => '/custom/pi' }), 1);
    assert.equal(external.updates.length, 0);
  }

  const latest = machine({ versions: { '/custom/pi': () => ({ status: 0, stdout: '1.4.0\n' }) } });
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.updateLatest': true }) };
  assert.equal(setup({ env, home, ...latest.options, find: () => '/custom/pi' }), 0);
  assert.equal(latest.updates.length, 0);
  assert.match(latest.said.at(-1), /无法自动升级.*原来的安装工具/);
});

test('a custom executable at the managed path is treated as external', () => {
  const m = machine({ versions: { [own]: () => ({ status: 0, stdout: '1.0.9\n' }) } });
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.updateLatest': true }) };
  assert.equal(setup({ env, home, ...m.options, find: () => own, realpath: path => path }), 1);
  assert.equal(m.updates.length, 0);
});

test('installer failures become the final setup line', () => {
  const m = machine({ updateResult: new Error('network unavailable') });
  assert.equal(setup({ env: {}, home, ...m.options, find: () => 'pi' }), 1);
  assert.match(m.said.at(-1), /^! 安装 Pi 失败：network unavailable/);
});

test('an update failure preserves an existing supported Pi', () => {
  const external = '/opt/homebrew/bin/pi';
  const m = machine({
    versions: { [external]: () => ({ status: 0, stdout: '1.4.0\n' }) },
    updateResult: new Error('npm registry unavailable'),
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  });
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.updateLatest': true }) };
  assert.equal(setup({ env, home, ...m.options, find: () => external }), 0);
  assert.equal(m.updates.length, 1);
  assert.match(m.said.at(-1), /继续使用已有的 Pi 1\.4\.0.*npm registry unavailable/);
});

test('a failed rollback fails setup even though the Pi seen before the update was supported', () => {
  const external = '/opt/homebrew/bin/pi';
  const m = machine({
    versions: { [external]: () => ({ status: 0, stdout: '1.4.0\n' }) },
    updateResult: new RollbackError('安装完成，但 /opt/homebrew/bin/pi 无法运行；恢复原 Pi 安装失败：EIO'),
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  });
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.updateLatest': true }) };
  assert.equal(setup({ env, home, ...m.options, find: () => external }), 1);
  assert.match(m.said.at(-1), /^! 更新 Pi 失败：.*恢复原 Pi 安装失败/);
});

test('an update failure keeps the existing Pi only if it still runs afterwards', () => {
  const external = '/opt/homebrew/bin/pi';
  let probes = 0;
  const m = machine({
    versions: { [external]: () => (++probes === 1 ? { status: 0, stdout: '1.4.0\n' } : { status: 1 }) },
    updateResult: new Error('npm registry unavailable'),
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  });
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.updateLatest': true }) };
  assert.equal(setup({ env, home, ...m.options, find: () => external }), 1);
  assert.equal(probes, 2);
  assert.match(m.said.at(-1), /^! 更新 Pi 失败：npm registry unavailable/);
});

// The layout 0.3.x setup left: `npm install --global --prefix $CODA_PLUGIN_STATE/pi`.
async function legacyInstall(t, version) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-legacy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const prefix = join(stateDir, 'pi');
  const bundle = join(prefix, 'lib/node_modules', PACKAGE, 'dist/bundle');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, 'cli.js'), '#!/usr/bin/env node\n');
  await chmod(join(bundle, 'cli.js'), 0o755);
  await mkdir(join(prefix, 'bin'));
  await symlink(`../lib/node_modules/${PACKAGE}/dist/bundle/cli.js`, join(prefix, 'bin/pi'));
  const env = { CODA_PLUGIN_STATE: stateDir, PATH: '' };
  const command = legacyManagedPi(env);
  // Only this temporary tree exists, whatever Pi the test machine has of its own.
  const find = (settings, options) => findPi(settings, {
    ...options,
    usable: path => path.startsWith(root) && existsSync(path),
  });
  const m = machine({
    versions: { [command]: () => ({ status: 0, stdout: `${version}\n` }) },
    updateResult: { version: '1.4.0', path: command },
    realpath: realpathSync,
  });
  return { root, prefix, env, command, find, m };
}

test('a Pi installed by the 0.3 plugin is found in its real npm prefix and kept', async t => {
  const legacy = await legacyInstall(t, '1.2.0');
  assert.equal(legacy.find({}, { env: legacy.env, home: legacy.root }), legacy.command);
  assert.equal(setup({ env: legacy.env, home: legacy.root, ...legacy.m.options, find: legacy.find }), 0);
  assert.equal(legacy.m.updates.length, 0);
  assert.deepEqual(legacy.m.said, [`已有 Pi 1.2.0 可用：${legacy.command}`]);
});

test('a too-old 0.3 plugin copy is updated in its own prefix and verified where it starts', async t => {
  const legacy = await legacyInstall(t, '1.0.9');
  assert.equal(setup({ env: legacy.env, home: legacy.root, ...legacy.m.options, find: legacy.find }), 0);
  assert.equal(legacy.m.updates.length, 1);
  assert.equal(legacy.m.said[0], `更新 Pi latest 到 ${legacy.prefix}`);
  assert.equal(legacy.m.said.at(-1), `已升级到兼容版本 Pi 1.4.0：${legacy.command}`);
});

test('an explicit 0.3 path is not reported ready when the update went elsewhere', async t => {
  const legacy = await legacyInstall(t, '1.0.9');
  const m = machine({
    versions: { [legacy.command]: () => ({ status: 0, stdout: '1.0.9\n' }) },
    updateResult: { version: '1.4.0', path: own },
    realpath: realpathSync,
  });
  const env = {
    ...legacy.env,
    CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.commandPath': legacy.command, 'pi.updateLatest': true }),
  };
  assert.equal(setup({ env, home: legacy.root, ...m.options, find: legacy.find }), 1);
  assert.equal(m.said[0], `更新 Pi latest 到 ${legacy.prefix}`);
  assert.match(m.said.at(-1), new RegExp(`^! 装好了 Pi 1\\.4\\.0.*会启动的 ${legacy.command} 是 1\\.0\\.9`));
});

test('a failed update of a too-old 0.3 copy fails setup', async t => {
  const legacy = await legacyInstall(t, '1.0.9');
  const m = machine({
    versions: { [legacy.command]: () => ({ status: 0, stdout: '1.0.9\n' }) },
    updateResult: new Error('migration failed'),
    realpath: realpathSync,
  });
  assert.equal(setup({ env: legacy.env, home: legacy.root, ...m.options, find: legacy.find }), 1);
  assert.match(m.said.at(-1), /更新 Pi 失败：migration failed/);
});

test('manifest and minimum-version metadata agree with the managed local runtime', async () => {
  const root = join(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.version, '0.5.0');
  assert.equal(manifest.dependencies[PACKAGE], undefined);
  assert.equal(manifest.devDependencies[PACKAGE], VERIFIED_PI_VERSION);
  assert.equal(lock.packages[''].devDependencies[PACKAGE], VERIFIED_PI_VERSION);
  assert.equal(lock.packages[`node_modules/${PACKAGE}`].version, VERIFIED_PI_VERSION);
  assert.equal(manifest.contributes.panels, undefined);
  assert.equal(manifest.contributes.configuration.properties['pi.updateLatest'].default, false);
  assert.equal(manifest.contributes.setup.command,
    'exec "$CODA_NODE" "$CODA_PLUGIN_PATH/agent/setup.mjs"');
  assert.equal(manifest.scripts['check:pi:verified'], 'node scripts/check-pi-compat.mjs --pi ./node_modules/.bin/pi');
  assert.match(manifest.contributes.configuration.properties['pi.commandPath'].description, /PATH.*npm.*Homebrew/);
});

test('resource-page runtime controls remain absent', async () => {
  const root = join(import.meta.dirname, '..');
  for (const path of [
    'agent/pi-runtime-panel.mjs',
    'agent/pi-runtime-action.mjs',
    'agent/pi-install.mjs',
    'agent/pi-install/package.json',
    'agent/pi-install/package-lock.json',
  ]) {
    await assert.rejects(stat(join(root, path)), error => error.code === 'ENOENT');
  }
});
