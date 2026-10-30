import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  MANAGED_PI_CLI,
  PACKAGE,
  VERIFIED_PI_VERSION,
  launchLabel,
  resolvePiLaunch,
} from '../agent/pi-command.mjs';
import { setup } from '../agent/setup.mjs';

const pluginPath = '/plugin/pi';
const node = '/coda/node/bin/node';
const managedCli = resolve(pluginPath, MANAGED_PI_CLI);

function machine(version = '1.4.0') {
  const ran = [], said = [];
  return {
    ran,
    said,
    options: {
      node,
      run: (command, args) => {
        ran.push([command, ...args]);
        return version instanceof Error
          ? { status: 1, stderr: version.message }
          : { status: 0, stdout: `${version}\n` };
      },
      say: line => said.push(line),
      fail: line => said.push(`! ${line}`),
    },
  };
}

test('the default launch is the exact Pi installed inside the Coda plugin', () => {
  const launch = resolvePiLaunch({}, { pluginPath, node });
  assert.deepEqual(launch, {
    command: node,
    prefixArgs: [managedCli],
    cliPath: managedCli,
    kind: 'managed',
  });
  assert.equal(launchLabel(launch), managedCli);
});

test('a PATH pi never overrides the plugin-managed runtime', () => {
  const launch = resolvePiLaunch(
    { 'pi.commandPath': 'pi' },
    { pluginPath, node, env: { PATH: '/usr/local/bin:/opt/homebrew/bin' } },
  );
  assert.equal(launch.kind, 'managed');
  assert.equal(launch.command, node);
  assert.deepEqual(launch.prefixArgs, [managedCli]);
});

test('an explicit non-pi commandPath remains the external override', () => {
  assert.deepEqual(
    resolvePiLaunch({ 'pi.commandPath': '/custom/bin/pi' }, { pluginPath, node }),
    { command: '/custom/bin/pi', prefixArgs: [], kind: 'external' },
  );
});

test('setup runs the selected Pi through CODA_NODE and reports the managed version', () => {
  const m = machine('1.4.0');
  const env = { CODA_PLUGIN_PATH: pluginPath };
  assert.equal(setup({ env, ...m.options }), 0);
  assert.deepEqual(m.ran, [[node, managedCli, '--version']]);
  assert.deepEqual(m.said, [`Pi 1.4.0 可用：${managedCli}`]);
});

test('setup verifies but does not replace an explicitly configured external Pi', () => {
  const m = machine('1.4.0');
  const env = {
    CODA_PLUGIN_PATH: pluginPath,
    CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.commandPath': '/custom/bin/pi' }),
  };
  assert.equal(setup({ env, ...m.options }), 0);
  assert.deepEqual(m.ran, [['/custom/bin/pi', '--version']]);
  assert.deepEqual(m.said, ['Pi 1.4.0 可用：/custom/bin/pi']);
});

test('setup rejects a missing or old runtime with plugin-update guidance', () => {
  const managed = machine(new Error('ENOENT'));
  assert.equal(setup({ env: { CODA_PLUGIN_PATH: pluginPath }, ...managed.options }), 1);
  assert.match(managed.said.at(-1), /更新或重新安装 Pi 插件/);

  const old = machine('1.0.0');
  const env = {
    CODA_PLUGIN_PATH: pluginPath,
    CODA_PLUGIN_SETTINGS: JSON.stringify({ 'pi.commandPath': '/custom/bin/pi' }),
  };
  assert.equal(setup({ env, ...old.options }), 1);
  assert.match(old.said.at(-1), /最低版本 1\.1\.0.*原安装方式/);
  assert.doesNotMatch(old.said.at(-1), /npm i -g|资源页/);
});

test('manifest updates Pi through the regular Coda plugin update path', async () => {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.version, '0.5.0');
  assert.equal(manifest.dependencies[PACKAGE], VERIFIED_PI_VERSION);
  assert.equal(lock.packages[''].version, '0.5.0');
  assert.equal(lock.packages[''].dependencies[PACKAGE], VERIFIED_PI_VERSION);
  assert.equal(lock.packages[`node_modules/${PACKAGE}`].version, VERIFIED_PI_VERSION);
  assert.equal(manifest.contributes.panels, undefined);
  assert.equal(manifest.contributes.setup.command,
    'exec "$CODA_NODE" "$CODA_PLUGIN_PATH/agent/setup.mjs"');
  assert.equal(manifest.scripts['check:pi:verified'], 'node scripts/check-pi-compat.mjs');
  assert.doesNotMatch(manifest.contributes.configuration.properties['pi.commandPath'].description, /资源页|扫描 PATH|常见安装目录/);
});

test('obsolete runtime-management files and nested install graph are absent', async () => {
  const root = resolve(import.meta.dirname, '..');
  for (const path of [
    'agent/pi-runtime.mjs',
    'agent/pi-runtime-panel.mjs',
    'agent/pi-runtime-action.mjs',
    'agent/pi-install.mjs',
    'agent/pi-install/package.json',
    'agent/pi-install/package-lock.json',
  ]) {
    await assert.rejects(stat(resolve(root, path)), error => error.code === 'ENOENT');
  }
});
