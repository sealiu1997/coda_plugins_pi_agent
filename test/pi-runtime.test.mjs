import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { managedPi, PACKAGE } from '../agent/pi-command.mjs';
import {
  compareVersions, inspectRuntime, latestVersion, npmOwner, updateLatest, versionOf
} from '../agent/pi-runtime.mjs';

const home = '/home/me';
const node = '/coda/node/bin/node';
const npm = '/coda/node/lib/node_modules/npm/bin/npm-cli.js';
const own = managedPi({}, home);

function runFor({ commandVersions = {}, npmLatest = '1.4.0', installStatus = 0, installedVersion = null } = {}) {
  const ran = [];
  const run = (command, args) => {
    ran.push([command, ...args]);
    if (command === node && args[0] === npm && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify(npmLatest) };
    }
    if (command === node && args[0] === npm && args[1] === 'install') {
      return { status: installStatus, stderr: installStatus ? 'npm failed' : '' };
    }
    const scripted = commandVersions[command];
    if (scripted) return scripted();
    if (command === own) return { status: 0, stdout: installedVersion ?? npmLatest };
    if (args.includes('--version')) return { status: 0, stdout: installedVersion ?? npmLatest };
    return { status: null, error: new Error('ENOENT') };
  };
  return { ran, run };
}

test('versions compare by numeric semver components', () => {
  assert.equal(compareVersions('1.4.0', '1.4.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.4.0'), 1);
  assert.equal(compareVersions('1.4.0', '2.0.0'), -1);
  assert.equal(compareVersions(null, '1.4.0'), null);
});

test('versionOf takes a bare version from stdout or stderr', () => {
  assert.equal(versionOf('/pi', { run: () => ({ status: 0, stdout: 'pi 1.4.0' }) }), '1.4.0');
  assert.equal(versionOf('/pi', { run: () => ({ status: 0, stderr: 'v2.0.1' }) }), '2.0.1');
  assert.equal(versionOf('/pi', { run: () => ({ status: 1, stdout: '1.4.0' }) }), null);
});

test('latestVersion asks npm for the exact latest tag', () => {
  const m = runFor({ npmLatest: '1.4.0' });
  assert.equal(latestVersion({ env: {}, node, run: m.run }), '1.4.0');
  assert.deepEqual(m.ran, [[node, npm, 'view', `${PACKAGE}@latest`, 'version', '--json', '--no-update-notifier']]);
});

test('npmOwner recognizes npm global and managed-prefix package layouts', () => {
  assert.deepEqual(npmOwner('/opt/homebrew/bin/pi', {
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
  }), {
    kind: 'npm',
    prefix: '/opt/homebrew',
    actual: '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
  });
  assert.equal(npmOwner('/project/node_modules/.bin/pi', {
    realpath: () => '/project/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
  }), null);
});

test('inspectRuntime reports a missing, current or outdated runtime', () => {
  const missingRun = runFor().run;
  assert.deepEqual(inspectRuntime({ env: {}, home, node, run: missingRun, find: () => 'pi' }), {
    path: null,
    version: null,
    latest: '1.4.0',
    latestError: null,
    owner: { kind: 'none' },
    updateAvailable: false,
    canUpdate: true
  });

  const current = inspectRuntime({ env: {}, home, node, run: runFor({ installedVersion: '1.4.0' }).run, find: () => own });
  assert.equal(current.version, '1.4.0');
  assert.equal(current.owner.kind, 'managed');
  assert.equal(current.updateAvailable, false);

  const old = inspectRuntime({ env: {}, home, node, run: runFor({ installedVersion: '1.1.0' }).run, find: () => own });
  assert.equal(old.version, '1.1.0');
  assert.equal(old.updateAvailable, true);
});

test('updateLatest installs the latest package into ~/.local for a missing Pi', () => {
  const m = runFor();
  let present = false;
  const result = updateLatest({
    env: {}, home, node,
    run: (command, args, options) => {
      const result = m.run(command, args, options);
      if (command === node && args[1] === 'install') present = true;
      return result;
    },
    find: () => present ? own : 'pi'
  });
  assert.equal(result.version, '1.4.0');
  assert.equal(result.installed, true);
  const install = m.ran.find(args => args[0] === node && args[2] === 'install');
  assert.deepEqual(install, [node, npm, 'install', '--global', '--prefix', join(home, '.local'), '--ignore-scripts',
    '--no-fund', '--no-audit', '--no-update-notifier', `${PACKAGE}@latest`]);
});

test('updateLatest updates an npm global installation in its own prefix', () => {
  const m = runFor({ installedVersion: '1.4.0' });
  const external = '/opt/homebrew/bin/pi';
  const result = updateLatest({
    env: {}, home, node, run: m.run, find: () => external,
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'
  });
  assert.equal(result.version, '1.4.0');
  const install = m.ran.find(args => args[0] === node && args[2] === 'install');
  assert.equal(install[5], '/opt/homebrew');
});

test('updateLatest refuses custom installers and reports npm failures', () => {
  const custom = runFor({ commandVersions: { '/custom/pi': () => ({ status: 0, stdout: '1.4.0' }) } });
  assert.throws(() => updateLatest({ env: {}, home, node, run: custom.run, find: () => '/custom/pi', realpath: () => '/custom/pi' }), /无法自动升级/);
  assert.equal(custom.ran.some(args => args[2] === 'install'), false);

  const failed = runFor({ installStatus: 1 });
  assert.throws(() => updateLatest({ env: {}, home, node, run: failed.run, find: () => own }), /npm failed/);
});
