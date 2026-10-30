import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedPi, managedPrefix, PACKAGE, versionOf } from '../agent/pi-command.mjs';
import {
  compareVersions,
  inspectRuntime,
  latestVersion,
  npmCli,
  npmOwner,
  runtimeOwner,
  updateLatest,
  wrapperTarget,
} from '../agent/pi-runtime.mjs';

const home = '/home/me';
const node = '/coda/node/bin/node';
const npm = '/coda/node/lib/node_modules/npm/bin/npm-cli.js';
const own = managedPi({}, home);
const managedActual = join(home, '.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const managedRealpath = path => path === own ? managedActual : path;
const noBackup = () => ({ restore() {}, commit() {} });

function runFor({
  commandVersions = {},
  npmLatest = '1.4.0',
  installStatus = 0,
  installedVersion = null,
  afterInstallVersion = npmLatest,
} = {}) {
  const calls = [];
  const ran = [];
  let installed = false;
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    ran.push([command, ...args]);
    if (command === node && args[0] === npm && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify(npmLatest) };
    }
    if (command === node && args[0] === npm && args[1] === 'install') {
      if (!installStatus) installed = true;
      return { status: installStatus, stderr: installStatus ? 'npm failed' : '' };
    }
    const scripted = commandVersions[command];
    if (scripted) return scripted();
    const version = installed ? afterInstallVersion : installedVersion ?? npmLatest;
    if (command === own) return { status: 0, stdout: version };
    if (args.includes('--version')) return { status: 0, stdout: version };
    return { status: null, error: new Error('ENOENT') };
  };
  return { calls, ran, run };
}

test('versions compare by numeric semver components', () => {
  assert.equal(compareVersions('1.4.0', '1.4.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.4.0'), 1);
  assert.equal(compareVersions('1.4.0', '2.0.0'), -1);
  assert.equal(compareVersions('1.4.0-beta.1', '1.4.0'), -1);
  assert.equal(compareVersions('1.4.0-beta.2', '1.4.0-beta.10'), -1);
  assert.equal(compareVersions('1.4.0+build.2', '1.4.0+build.1'), 0);
  assert.equal(compareVersions(null, '1.4.0'), null);
});

test('versionOf reads stdout or stderr with a bounded timeout', () => {
  let options;
  assert.equal(versionOf('/opt/pi/bin/pi', {
    env: { PATH: '/usr/bin' },
    node: '/coda/node/bin/node',
    run: (_command, _args, value) => {
      options = value;
      return { status: 0, stdout: 'pi 1.4.0' };
    },
  }), '1.4.0');
  assert.equal(options.timeout, 5_000);
  assert.equal(options.env.PATH, '/coda/node/bin:/opt/pi/bin:/usr/bin');
  assert.equal(versionOf('/pi', { run: () => ({ status: 0, stderr: 'v2.0.1' }) }), '2.0.1');
  assert.equal(versionOf('/pi', { run: () => ({ status: 1, stdout: '1.4.0' }) }), null);
});

test('latestVersion asks npm for the exact latest tag', () => {
  const m = runFor({ npmLatest: '1.4.0' });
  assert.equal(latestVersion({ env: {}, node, run: m.run }), '1.4.0');
  assert.deepEqual(m.ran, [[node, npm, 'view', `${PACKAGE}@latest`, 'version', '--json', '--no-update-notifier']]);
  assert.equal(m.calls[0].options.timeout, 12_000);
});

test('npmCli locates npm in Coda, Homebrew and nvm Node layouts', () => {
  const layouts = [
    ['/coda/node/bin/node', '/coda/node/lib/node_modules/npm/bin/npm-cli.js'],
    ['/opt/homebrew/bin/node', '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js'],
    ['/Users/me/.nvm/versions/node/v22.14.0/bin/node',
      '/Users/me/.nvm/versions/node/v22.14.0/lib/node_modules/npm/bin/npm-cli.js'],
  ];
  for (const [nodePath, expected] of layouts) {
    assert.equal(npmCli(nodePath, { exists: candidate => candidate === expected }), expected);
  }
  assert.equal(npmCli('/opt/homebrew/bin/node', {
    exists: candidate => candidate.includes('/libexec/lib/node_modules/npm/bin/npm-cli.js'),
  }), '/opt/homebrew/libexec/lib/node_modules/npm/bin/npm-cli.js');
});

test('npmOwner recognizes global npm package layouts', () => {
  assert.deepEqual(npmOwner('/opt/homebrew/bin/pi', {
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  }), {
    kind: 'npm',
    prefix: '/opt/homebrew',
    actual: '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  });
  assert.equal(npmOwner('/project/node_modules/.bin/pi', {
    realpath: () => '/project/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
  }), null);
});

test('runtimeOwner distinguishes managed npm packages from custom executables', () => {
  assert.equal(runtimeOwner(own, { env: {}, home, realpath: managedRealpath }).kind, 'managed');
  assert.equal(runtimeOwner(own, { env: {}, home, realpath: path => path }).kind, 'external');
  assert.deepEqual(runtimeOwner('/opt/homebrew/bin/pi', {
    env: {},
    home,
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  }), {
    kind: 'npm',
    prefix: '/opt/homebrew',
    actual: '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
  });
});

test('runtimeOwner follows a conservative shell wrapper into its npm installation', () => {
  const wrapper = join(home, '.local/bin/pi');
  const target = '/opt/homebrew/bin/pi';
  const actual = '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  const source = [
    '#!/bin/sh',
    'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"',
    `exec ${target} "$@"`,
    '',
  ].join('\n');
  const options = {
    env: {},
    home,
    realpath: path => path === wrapper ? wrapper : path,
    readFile: path => {
      if (path === wrapper) return source;
      throw new Error('not a wrapper');
    },
  };
  assert.equal(wrapperTarget(wrapper, options), target);
  assert.deepEqual(runtimeOwner(wrapper, {
    ...options,
    realpath: path => path === wrapper ? wrapper : path === target ? actual : path,
  }), {
    kind: 'npm',
    prefix: '/opt/homebrew',
    actual,
  });
});

test('wrapperTarget rejects shell logic it cannot identify safely', () => {
  const wrapper = join(home, 'pi');
  const cases = [
    `#!/bin/sh\nexec "$PI_BIN" "$@"\n`,
    `#!/bin/sh\nexec ../bin/pi "$@"\n`,
    `#!/bin/sh\necho unsafe\nexec /opt/homebrew/bin/pi "$@"\n`,
    `#!/bin/sh\nexec /opt/homebrew/bin/pi "$@"\nexec /tmp/other "$@"\n`,
    `#!/usr/bin/env node\nconsole.log("1.4.0")\n`,
    `#!/bin/sh\nPATH=/one\nPATH=/two\nexec /opt/homebrew/bin/pi "$@"\n`,
  ];
  for (const source of cases) {
    assert.equal(wrapperTarget(wrapper, {
      realpath: path => path,
      readFile: () => source,
    }), null, source);
  }
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
    canUpdate: true,
  });

  const current = inspectRuntime({
    env: {}, home, node, run: runFor({ installedVersion: '1.4.0' }).run, find: () => own, realpath: managedRealpath,
  });
  assert.equal(current.version, '1.4.0');
  assert.equal(current.owner.kind, 'managed');
  assert.equal(current.updateAvailable, false);

  const old = inspectRuntime({
    env: {}, home, node, run: runFor({ installedVersion: '1.1.0' }).run, find: () => own, realpath: managedRealpath,
  });
  assert.equal(old.version, '1.1.0');
  assert.equal(old.updateAvailable, true);
});

test('updateLatest installs into ~/.local for a missing Pi', () => {
  const m = runFor();
  let present = false;
  const result = updateLatest({
    env: {},
    home,
    node,
    run: (command, args, options) => {
      const value = m.run(command, args, options);
      if (command === node && args[1] === 'install') present = true;
      return value;
    },
    find: () => present ? own : 'pi',
    realpath: managedRealpath,
    backup: noBackup,
  });
  assert.equal(result.version, '1.4.0');
  assert.equal(result.installed, true);
  const install = m.ran.find(args => args[0] === node && args[2] === 'install');
  assert.deepEqual(install, [
    node, npm, 'install', '--global', '--prefix', managedPrefix({}, home), '--ignore-scripts',
    '--no-fund', '--no-audit', '--no-update-notifier', `${PACKAGE}@1.4.0`,
  ]);
});

test('updateLatest updates a recognized npm global install in its own prefix', () => {
  const m = runFor({ installedVersion: '1.2.0', afterInstallVersion: '1.4.0' });
  const external = '/opt/homebrew/bin/pi';
  const result = updateLatest({
    env: {},
    home,
    node,
    run: m.run,
    find: () => external,
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
    backup: noBackup,
  });
  assert.equal(result.version, '1.4.0');
  const install = m.ran.find(args => args[0] === node && args[2] === 'install');
  assert.equal(install[5], '/opt/homebrew');
});

test('updateLatest skips npm when the installed Pi is already latest', () => {
  const m = runFor({ installedVersion: '1.4.0' });
  const external = '/opt/homebrew/bin/pi';
  const result = updateLatest({
    env: {},
    home,
    node,
    run: m.run,
    find: () => external,
    realpath: () => '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
    backup: noBackup,
  });
  assert.equal(result.version, '1.4.0');
  assert.equal(result.latest, '1.4.0');
  assert.equal(result.changed, false);
  assert.equal(m.ran.some(args => args[2] === 'install'), false);
});

test('updateLatest refuses custom installers and reports npm failures', () => {
  const custom = runFor({ commandVersions: { '/custom/pi': () => ({ status: 0, stdout: '1.4.0' }) } });
  assert.throws(() => updateLatest({
    env: {}, home, node, run: custom.run, find: () => '/custom/pi', realpath: () => '/custom/pi',
    backup: noBackup,
  }), /无法自动升级/);
  assert.equal(custom.ran.some(args => args[2] === 'install'), false);

  const failed = runFor({ installStatus: 1, installedVersion: '1.2.0' });
  assert.throws(() => updateLatest({
    env: {}, home, node, run: failed.run, find: () => own, realpath: managedRealpath,
    backup: noBackup,
  }), /npm failed/);
});

test('a failed verification restores the previous npm installation', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-rollback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'prefix');
  const packageDir = join(prefix, 'lib/node_modules/@earendil-works/pi-coding-agent');
  const cli = join(packageDir, 'dist/bundle/cli.js');
  const command = join(prefix, 'bin/pi');
  const commandTarget = '../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
  mkdirSync(join(packageDir, 'dist/bundle'), { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(cli, "console.log('1.2.0');\n");
  symlinkSync(commandTarget, command);

  let installing = false;
  const run = (_command, args) => {
    if (args[0] === npm && args[1] === 'view') return { status: 0, stdout: JSON.stringify('1.4.0') };
    if (args[0] === npm && args[1] === 'install') {
      installing = true;
      mkdirSync(join(packageDir, 'dist/bundle'), { recursive: true });
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      writeFileSync(cli, 'broken');
      symlinkSync(commandTarget, command);
      return { status: 0 };
    }
    if (args.includes('--version')) {
      return installing
        ? { status: 1, stderr: 'broken install' }
        : { status: 0, stdout: '1.2.0' };
    }
    return { status: 1 };
  };

  assert.throws(() => updateLatest({
    env: {},
    home,
    node,
    run,
    find: () => command,
  }), /无法运行/);
  assert.equal(readFileSync(cli, 'utf8'), "console.log('1.2.0');\n");
  assert.equal(readlinkSync(command), commandTarget);
  assert.equal(existsSync(join(prefix, 'lib/node_modules/.package-lock.json')), false);
});
