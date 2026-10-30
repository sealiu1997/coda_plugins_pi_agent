import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findPi, legacyManagedPi, managedPi, managedPrefix, PACKAGE, VERIFIED_PI_VERSION
} from '../agent/pi-command.mjs';
import { setup } from '../agent/setup.mjs';

const home = '/home/me';
const state = '/state/pi-plugin';
const own = join(home, '.local/bin/pi');

function machine(versions = {}, updateResult = { version: '1.4.0', path: own, installed: true }) {
  const ran = [], said = [], updates = [];
  const run = (command, args) => {
    ran.push([command, ...args]);
    return versions[command]?.() ?? { status: null, error: new Error('ENOENT') };
  };
  return {
    ran, said, updates,
    options: {
      node: '/coda/node/bin/node', run, update: options => {
        updates.push(options);
        if (updateResult instanceof Error) throw updateResult;
        return updateResult;
      },
      say: line => said.push(line),
      fail: line => said.push(`! ${line}`)
    }
  };
}

test('Pi lookup uses Coda settings, PATH, common installs, the managed ~/.local copy, then the legacy state copy', () => {
  const find = (settings, usable) => findPi(settings, {
    env: { PATH: '/a:/b', CODA_PLUGIN_STATE: state }, home, usable: path => usable.includes(path)
  });
  assert.equal(find({ 'pi.commandPath': '/opt/pi' }, []), '/opt/pi');
  assert.equal(find({}, ['/b/pi', own]), '/b/pi');
  assert.equal(find({ 'pi.commandPath': 'pi' }, [own, legacyManagedPi({ CODA_PLUGIN_STATE: state })]), own);
  assert.equal(find({}, [legacyManagedPi({ CODA_PLUGIN_STATE: state })]), legacyManagedPi({ CODA_PLUGIN_STATE: state }));
  assert.equal(find({}, []), 'pi');
});

test('the managed runtime is a normal npm prefix at ~/.local, with a state-installed legacy path still discoverable', () => {
  assert.equal(managedPrefix({}, home), join(home, '.local'));
  assert.equal(managedPrefix({ CODA_PI_PREFIX: '/managed' }, home), '/managed');
  assert.equal(managedPi({}, home), own);
  assert.equal(legacyManagedPi({ CODA_PLUGIN_STATE: state }), join(state, 'pi/node_modules/.bin/pi'));
});

test('a pi file on PATH that cannot run is skipped', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const brokenDir = join(dir, 'broken'), workingDir = join(dir, 'working');
  await mkdir(brokenDir);
  await mkdir(workingDir);
  const broken = join(brokenDir, 'pi'), working = join(workingDir, 'pi');
  await writeFile(broken, '#!/bin/sh\n');
  await writeFile(working, '#!/bin/sh\necho 1.2.3\n');
  await chmod(working, 0o755);
  assert.equal(findPi({}, { env: { PATH: `${brokenDir}:${workingDir}` }, home: dir }), working);
});

test('an existing usable Pi is kept and never invokes the installer', () => {
  const m = machine({ '/usr/local/bin/pi': () => ({ status: 0, stdout: 'pi 1.4.0\n' }) });
  assert.equal(setup({ env: { PATH: '/usr/bin' }, home, ...m.options, find: () => '/usr/local/bin/pi' }), 0);
  assert.deepEqual(m.ran, [['/usr/local/bin/pi', '--version']]);
  assert.equal(m.updates.length, 0);
  assert.deepEqual(m.said, ['已有 Pi 1.4.0：/usr/local/bin/pi']);
});

test('a missing Pi installs npm latest into the managed ~/.local prefix', () => {
  const m = machine();
  assert.equal(setup({ env: {}, home, ...m.options, find: () => 'pi' }), 0);
  assert.equal(m.ran.length, 0, 'the finder already established that no Pi exists');
  assert.equal(m.updates.length, 1);
  assert.equal(m.said[0], `安装 Pi latest 到 ${own}`);
  assert.equal(m.said.at(-1), `已安装 Pi 1.4.0：${own}`);
});

test('an old or broken external Pi is reported and left untouched', () => {
  for (const answer of [{ status: 0, stdout: '1.0.9\n' }, { status: 1 }]) {
    const m = machine({ '/usr/local/bin/pi': () => answer });
    assert.equal(setup({ env: {}, home, ...m.options, find: () => '/usr/local/bin/pi' }), 1);
    assert.equal(m.updates.length, 0);
    assert.deepEqual(m.ran, [['/usr/local/bin/pi', '--version']]);
  }
});

test('an explicitly pinned managed path is never overwritten by setup', () => {
  const broken = machine({});
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.commandPath': own }) };
  assert.equal(setup({ env, home, ...broken.options, find: () => own }), 1);
  assert.equal(broken.updates.length, 0);
});

test('managed copies below the minimum are replaced with latest, while an explicit upgrade updates a usable managed copy', () => {
  const old = machine({ [own]: () => ({ status: 0, stdout: '1.0.9\n' }) });
  assert.equal(setup({ env: {}, home, ...old.options, find: () => own }), 0);
  assert.equal(old.updates.length, 1);

  const current = machine({ [own]: () => ({ status: 0, stdout: '1.1.0\n' }) });
  assert.equal(setup({ env: {}, home, ...current.options, find: () => own, upgradeLatest: true }), 0);
  assert.equal(current.updates.length, 1);
});

test('an explicit latest request preserves usable external Pi and configured paths', () => {
  const external = machine({ '/external/pi': () => ({ status: 0, stdout: '1.2.0\n' }) });
  assert.equal(setup({ env: {}, home, ...external.options, find: () => '/external/pi', upgradeLatest: true }), 0);
  assert.equal(external.updates.length, 0);

  const configured = machine({ '/external/pi': () => ({ status: 0, stdout: '1.4.0\n' }) });
  const env = { CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.commandPath': '/external/pi' }) };
  assert.equal(setup({ env, home, ...configured.options, upgradeLatest: true }), 0);
  assert.equal(configured.updates.length, 0);
});

test('installer failures are the last setup line', () => {
  const m = machine({}, new Error('network unavailable'));
  assert.equal(setup({ env: {}, home, ...m.options, find: () => 'pi' }), 1);
  assert.match(m.said.at(-1), /^! 安装 Pi 失败：network unavailable/);
});

test('minimum, verified scanner, baseline and Coda runtime panel agree', async () => {
  const { MIN_PI_VERSION } = await import('../agent/pi-command.mjs');
  const baseline = JSON.parse(await readFile(new URL('../compat/pi-snapshot.json', import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(MIN_PI_VERSION, VERIFIED_PI_VERSION);
  assert.equal(baseline.version, MIN_PI_VERSION);
  assert.equal(baseline.reviewed, true);
  assert.equal(manifest.scripts['check:pi:verified'], `node scripts/check-pi-compat.mjs --install ${VERIFIED_PI_VERSION}`);
  assert.equal(manifest.devDependencies['@coda-console/plugin-check'], '0.5.8');
  assert.equal(manifest.contributes.panels[0].actions['update-latest'].command,
    'node "$CODA_PLUGIN_PATH/agent/pi-runtime-action.mjs"');
  assert.equal(manifest.contributes.setup.command, 'exec "$CODA_NODE" "$CODA_PLUGIN_PATH/agent/setup.mjs"');
});

test('bundled exact npm graph remains available to the compatibility scanner', async t => {
  const { prepareRuntime } = await import('../agent/pi-install.mjs');
  const manifest = JSON.parse(await readFile(new URL('../agent/pi-install/package.json', import.meta.url)));
  const lock = JSON.parse(await readFile(new URL('../agent/pi-install/package-lock.json', import.meta.url)));
  assert.equal(manifest.dependencies[PACKAGE], VERIFIED_PI_VERSION);
  assert.equal(lock.packages[''].dependencies[PACKAGE], VERIFIED_PI_VERSION);
  for (const [name, version] of Object.entries(manifest.overrides)) {
    assert.equal(version, VERIFIED_PI_VERSION);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  const dir = await mkdtemp(join(tmpdir(), 'pi-prepare-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  prepareRuntime(dir);
  assert.equal(JSON.parse(await readFile(join(dir, 'package-lock.json'))).lockfileVersion, 3);
});

test('a legacy managed copy stays usable during migration', async () => {
  const legacy = legacyManagedPi({ CODA_PLUGIN_STATE: state });
  const m = machine({ [legacy]: () => ({ status: 0, stdout: '1.1.0\n' }) });
  assert.equal(setup({ env: { CODA_PLUGIN_STATE: state }, home, ...m.options, find: () => legacy }), 0);
  assert.equal(m.updates.length, 0);
});
