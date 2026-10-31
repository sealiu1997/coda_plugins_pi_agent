import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { legacyManagedPi, managedPi, managedPrefix, PACKAGE, versionOf } from '../agent/pi-command.mjs';
import {
  RollbackError,
  acquireUpdateLock,
  compareVersions,
  inspectRuntime,
  latestVersion,
  npmCli,
  npmOwner,
  pnpmShimTarget,
  recoverIdleInstallation,
  recoverInterruptedInstallation,
  recoverPendingInstallation,
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
const backupName = '.coda-pi-backup-';
const transactionRecordPath = (stateDir, prefix) => join(
  stateDir,
  'pi-runtime-transactions',
  `${createHash('sha256').update(normalize(prefix)).digest('hex')}.json`,
);

const stageOf = args => args[args.indexOf('--prefix') + 1];
const leftovers = prefix => readdirSync(prefix).filter(name => name.startsWith('.coda-pi-'));
const lockPath = prefix => join(prefix, '.coda-pi-update.lock');
const lockOwners = prefix => readdirSync(lockPath(prefix)).filter(name => name.startsWith('owner-'));
const deadPid = 999_999_999;

function holdLock(prefix, pid = deadPid) {
  const lock = lockPath(prefix);
  mkdirSync(lock, { recursive: true });
  const owner = `owner-${pid}-${randomUUID()}`;
  writeFileSync(join(lock, owner), '');
  return owner;
}

// The shape npm gives a global install: the package under lib/node_modules and a relative bin link.
function writeInstall(prefix, version) {
  const bundle = join(prefix, 'lib/node_modules', PACKAGE, 'dist/bundle');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'cli.js'), `${version}\n`);
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  rmSync(join(prefix, 'bin/pi'), { force: true });
  symlinkSync(`../lib/node_modules/${PACKAGE}/dist/bundle/cli.js`, join(prefix, 'bin/pi'));
}

function packageFixture(t, version = '1.2.0') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-runtime-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'prefix');
  const packageDir = join(prefix, 'lib/node_modules', PACKAGE);
  const cli = join(packageDir, 'dist/bundle/cli.js');
  const command = join(prefix, 'bin/pi');
  const commandTarget = `../lib/node_modules/${PACKAGE}/dist/bundle/cli.js`;
  writeInstall(prefix, version);
  const writePackageVersion = value => {
    mkdirSync(join(packageDir, 'dist/bundle'), { recursive: true });
    writeFileSync(cli, `${value}\n`);
  };
  const transaction = states => ({
    schemaVersion: 1,
    phase: 'install',
    states: [
      { name: 'package', path: packageDir, existed: true, moved: false, restored: false, ...states?.package },
      { name: 'command', path: command, existed: true, moved: false, restored: false, ...states?.command },
    ],
  });
  return { root, prefix, packageDir, cli, command, commandTarget, writePackageVersion, transaction };
}

// npm and Pi on a real temporary filesystem: `pi --version` prints the file its command resolves to.
function npmMachine({
  latest = '1.4.0',
  install = args => writeInstall(stageOf(args), latest),
  aliases = {},
  version = () => null,
} = {}) {
  const installs = [];
  const run = (command, args) => {
    if (command === node && args[0] === npm && args[1] === 'view') {
      return { status: 0, stdout: JSON.stringify(latest) };
    }
    if (command === node && args[0] === npm && args[1] === 'install') {
      installs.push(args);
      return install(args) ?? { status: 0 };
    }
    if (args.includes('--version')) {
      const scripted = version(command);
      if (scripted) return scripted;
      try {
        return { status: 0, stdout: readFileSync(aliases[command] ?? command, 'utf8') };
      } catch {
        return { status: 1, stderr: 'missing' };
      }
    }
    return { status: 1 };
  };
  return { run, installs };
}

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

test('updateLatest installs into ~/.local for a missing Pi through a stage', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-missing-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = managedPrefix({}, root);
  const command = managedPi({}, root);
  const m = npmMachine();

  const result = updateLatest({
    env: {},
    home: root,
    node,
    run: m.run,
    find: () => existsSync(command) ? command : 'pi',
  });
  assert.equal(result.version, '1.4.0');
  assert.equal(result.installed, true);
  assert.equal(result.path, command);
  assert.equal(m.installs.length, 1);
  const [install] = m.installs;
  assert.ok(stageOf(install).startsWith(join(prefix, '.coda-pi-stage-')));
  assert.deepEqual(install.toSpliced(4, 1), [
    npm, 'install', '--global', '--prefix', '--ignore-scripts',
    '--no-fund', '--no-audit', '--no-update-notifier', `${PACKAGE}@1.4.0`,
  ]);
  assert.equal(readFileSync(command, 'utf8'), '1.4.0\n');
  assert.deepEqual(leftovers(prefix), []);
});

test('npm writes only the stage; the existing npm install changes after the staged Pi runs', t => {
  const fixture = packageFixture(t);
  const m = npmMachine({
    install: args => {
      assert.notEqual(stageOf(args), fixture.prefix);
      assert.equal(readFileSync(fixture.cli, 'utf8'), '1.2.0\n');
      writeInstall(stageOf(args), '1.4.0');
    },
  });

  const result = updateLatest({ env: {}, home: fixture.root, node, run: m.run, find: () => fixture.command });
  assert.equal(result.version, '1.4.0');
  assert.equal(result.prefix, fixture.prefix);
  assert.equal(readFileSync(fixture.cli, 'utf8'), '1.4.0\n');
  assert.equal(readlinkSync(fixture.command), fixture.commandTarget);
  assert.deepEqual(leftovers(fixture.prefix), []);
});

test('a Pi installed by the 0.3 plugin is updated in its own prefix under plugin state', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-legacy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { CODA_PLUGIN_STATE: join(root, 'state') };
  const prefix = join(root, 'state/pi');
  writeInstall(prefix, '1.0.9');
  const command = legacyManagedPi(env);
  assert.equal(command, join(prefix, 'bin/pi'));
  assert.deepEqual(runtimeOwner(command, { env, home: root }).prefix, prefix);

  const result = updateLatest({ env, home: root, node, run: npmMachine().run, find: () => command });
  assert.equal(result.path, command);
  assert.equal(result.prefix, prefix);
  assert.equal(readFileSync(command, 'utf8'), '1.4.0\n');
  assert.equal(existsSync(managedPrefix(env, root)), false);
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
  });
  assert.equal(result.version, '1.4.0');
  assert.equal(result.latest, '1.4.0');
  assert.equal(result.changed, false);
  assert.equal(m.ran.some(args => args[2] === 'install'), false);
});

test('updateLatest refuses custom installers before contacting npm', () => {
  const custom = runFor({ commandVersions: { '/custom/pi': () => ({ status: 0, stdout: '1.4.0' }) } });
  assert.throws(() => updateLatest({
    env: {}, home, node, run: custom.run, find: () => '/custom/pi', realpath: () => '/custom/pi',
  }), /无法自动升级/);
  assert.equal(custom.ran.some(args => args[2] === 'install'), false);
});

test('stage failures leave the existing installation untouched', async t => {
  const cases = [
    ['npm exits non-zero after writing the stage', {
      install: args => {
        writeInstall(stageOf(args), 'half written');
        return { status: 1, stderr: 'npm failed after changing files' };
      },
    }, /npm failed after changing files/],
    ['the staged Pi cannot run', {
      install: args => writeInstall(stageOf(args), 'broken'),
    }, /无法运行/],
    ['npm latest is a prerelease', {
      latest: '1.5.0-beta.1',
    }, /不是当前插件支持的稳定版本/],
  ];
  for (const [name, options, error] of cases) {
    await t.test(name, t => {
      const fixture = packageFixture(t);
      const m = npmMachine(options);
      assert.throws(() => updateLatest({
        env: {}, home: fixture.root, node, run: m.run, find: () => fixture.command,
      }), error);
      assert.equal(m.installs.length, 1);
      assert.equal(readFileSync(fixture.cli, 'utf8'), '1.2.0\n');
      assert.equal(readlinkSync(fixture.command), fixture.commandTarget);
      assert.deepEqual(leftovers(fixture.prefix), []);
    });
  }
});

test('a committed install that fails verification is rolled back', t => {
  const fixture = packageFixture(t);
  // The staged Pi runs; once moved into place the same version no longer starts.
  const m = npmMachine({
    version: command => command === fixture.command && readFileSync(fixture.cli, 'utf8') === '1.4.0\n'
      ? { status: 1, stderr: 'broken after move' }
      : null,
  });

  assert.throws(() => updateLatest({
    env: {}, home: fixture.root, node, run: m.run, find: () => fixture.command,
  }), /无法运行/);
  assert.equal(readFileSync(fixture.cli, 'utf8'), '1.2.0\n');
  assert.equal(readlinkSync(fixture.command), fixture.commandTarget);
  assert.deepEqual(leftovers(fixture.prefix), []);
});

test('a failed rollback is reported as RollbackError and keeps the backup', t => {
  const fixture = packageFixture(t);
  const scope = dirname(fixture.packageDir);
  const m = npmMachine({
    version: command => {
      if (command !== fixture.command || readFileSync(fixture.cli, 'utf8') !== '1.4.0\n') return null;
      // Verification of the committed install fails, and the package location can no longer be restored.
      rmSync(scope, { recursive: true, force: true });
      writeFileSync(scope, 'not a directory\n');
      return { status: 1, stderr: 'broken after move' };
    },
  });

  assert.throws(() => updateLatest({
    env: {}, home: fixture.root, node, run: m.run, find: () => fixture.command,
  }), error => error instanceof RollbackError && /恢复原 Pi 安装失败/.test(error.message));
  const backups = leftovers(fixture.prefix).filter(name => name.startsWith(backupName));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(fixture.prefix, backups[0], 'package/dist/bundle/cli.js'), 'utf8'), '1.2.0\n');
});

test('interrupted backups are restored even when the transaction misses the completed rename', t => {
  const fixture = packageFixture(t);
  const backupRoot = mkdtempSync(join(fixture.prefix, backupName));
  renameSync(fixture.packageDir, join(backupRoot, 'package'));
  const transaction = fixture.transaction({
    package: { moved: false },
  });
  writeFileSync(join(backupRoot, 'transaction.json'), `${JSON.stringify(transaction, null, 2)}\n`);

  assert.equal(recoverInterruptedInstallation(fixture.prefix), true);
  assert.equal(readFileSync(fixture.cli, 'utf8'), '1.2.0\n');
  assert.equal(existsSync(backupRoot), false);
});

test('a committed backup is cleaned on recovery without rolling back the new installation', t => {
  const fixture = packageFixture(t, '1.2.0');
  const backupRoot = mkdtempSync(join(fixture.prefix, backupName));
  renameSync(fixture.packageDir, join(backupRoot, 'package'));
  fixture.writePackageVersion('1.4.0');
  const transaction = fixture.transaction({
    package: { moved: true },
  });
  transaction.phase = 'committed';
  writeFileSync(join(backupRoot, 'transaction.json'), `${JSON.stringify(transaction, null, 2)}\n`);

  assert.equal(recoverInterruptedInstallation(fixture.prefix), true);
  assert.equal(readFileSync(fixture.cli, 'utf8'), '1.4.0\n');
  assert.equal(existsSync(backupRoot), false);
});

test('an empty backup interrupted before its first manifest rename is removed', t => {
  const fixture = packageFixture(t);
  const backupRoot = mkdtempSync(join(fixture.prefix, backupName));
  writeFileSync(join(backupRoot, 'transaction.json.999.tmp'), '{"schemaVersion":1}');

  assert.equal(recoverInterruptedInstallation(fixture.prefix), true);
  assert.equal(existsSync(backupRoot), false);
});

test('a recorded external npm prefix is recovered after its command was moved away', t => {
  const fixture = packageFixture(t);
  const stateDir = join(fixture.root, 'state');
  const transactionDir = join(stateDir, 'pi-runtime-transactions');
  const backupRoot = mkdtempSync(join(fixture.prefix, backupName));
  renameSync(fixture.packageDir, join(backupRoot, 'package'));
  renameSync(fixture.command, join(backupRoot, 'command'));
  const transaction = fixture.transaction({
    package: { moved: true },
    command: { moved: true },
  });
  writeFileSync(join(backupRoot, 'transaction.json'), JSON.stringify(transaction));
  holdLock(fixture.prefix);
  mkdirSync(transactionDir, { recursive: true });
  const record = transactionRecordPath(stateDir, fixture.prefix);
  writeFileSync(record, JSON.stringify({
    schemaVersion: 1,
    prefix: fixture.prefix,
    backupRoot,
  }));
  const env = { CODA_PLUGIN_STATE: stateDir };

  assert.equal(recoverPendingInstallation({ env }), true);
  assert.equal(readFileSync(fixture.cli, 'utf8'), '1.2.0\n');
  assert.equal(readlinkSync(fixture.command), fixture.commandTarget);
  assert.deepEqual(leftovers(fixture.prefix), []);
  assert.equal(existsSync(record), false);
});

test('a failed recovery keeps the backup and stops the update with RollbackError', t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-recovery-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'prefix');
  mkdirSync(prefix);
  writeFileSync(join(prefix, 'lib'), 'blocks directory creation\n');
  const backupRoot = mkdtempSync(join(prefix, backupName));
  writeFileSync(join(backupRoot, 'package'), 'old package\n');
  const transaction = {
    schemaVersion: 1,
    phase: 'install',
    states: [{
      name: 'package',
      path: join(prefix, 'lib/node_modules', PACKAGE),
      existed: true,
      moved: true,
      restored: false,
    }],
  };
  writeFileSync(join(backupRoot, 'transaction.json'), `${JSON.stringify(transaction, null, 2)}\n`);
  holdLock(prefix);

  const external = join(root, 'external-pi');
  const m = runFor({ installedVersion: '1.2.0' });
  assert.throws(() => updateLatest({
    env: {},
    home: root,
    node,
    run: m.run,
    find: () => external,
    realpath: () => join(prefix, 'lib/node_modules', PACKAGE, 'dist/bundle/cli.js'),
  }), error => error instanceof RollbackError && /未完成备份保留/.test(error.message));
  assert.equal(existsSync(join(backupRoot, 'package')), true);
  assert.equal(m.ran.some(args => args[2] === 'install'), false);
});

test('an active update lock prevents a concurrent npm install', t => {
  const fixture = packageFixture(t);
  holdLock(fixture.prefix, process.pid);
  const m = npmMachine();

  assert.throws(() => updateLatest({
    env: {}, home: fixture.root, node, run: m.run, find: () => fixture.command,
  }), /另一个 Pi 更新正在进行/);
  assert.equal(m.installs.length, 0);
});

test('setup recovery removes a stale lock and leftovers of dead updaters', t => {
  const fixture = packageFixture(t);
  holdLock(fixture.prefix);
  const stage = mkdtempSync(join(fixture.prefix, '.coda-pi-stage-'));
  writeInstall(stage, '1.4.0');
  const deadDraft = mkdtempSync(`${lockPath(fixture.prefix)}.new-${deadPid}-`);
  const liveDraft = mkdtempSync(`${lockPath(fixture.prefix)}.new-${process.pid}-`);

  assert.equal(recoverIdleInstallation(fixture.prefix), true);
  assert.deepEqual(leftovers(fixture.prefix), [liveDraft.slice(fixture.prefix.length + 1)]);
  assert.equal(existsSync(deadDraft), false);
  // An npm process orphaned by a killed setup may still write its stage; the install is not affected.
  writeInstall(stage, '1.4.0');
  assert.equal(readFileSync(fixture.cli, 'utf8'), '1.2.0\n');
});

test('reclaiming a stale lock cannot take a lock another process acquired meanwhile', t => {
  const fixture = packageFixture(t);
  const stale = holdLock(fixture.prefix);
  let other = null;
  // Between reading the stale owner and replacing it, another process reclaims the same lock.
  const alive = pid => {
    if (pid === deadPid && !other) {
      other = acquireUpdateLock(fixture.prefix, { alive: candidate => candidate === process.pid });
      return false;
    }
    return pid === process.pid;
  };

  assert.throws(() => acquireUpdateLock(fixture.prefix, { alive }), /另一个 Pi 更新正在进行/);
  const [owner] = lockOwners(fixture.prefix);
  assert.notEqual(owner, stale);
  assert.match(owner, new RegExp(`^owner-${process.pid}-`));
  other();
  assert.equal(existsSync(lockPath(fixture.prefix)), false);
});

test('a lock that does not hold exactly one owner is not taken over', t => {
  const fixture = packageFixture(t);
  mkdirSync(lockPath(fixture.prefix));
  writeFileSync(join(lockPath(fixture.prefix), 'owner.json'), '{}');

  assert.throws(() => acquireUpdateLock(fixture.prefix), /锁内容无法识别/);
  assert.equal(existsSync(join(lockPath(fixture.prefix), 'owner.json')), true);
});

test('setup recovery serializes a leftover transaction record before deleting it', t => {
  const fixture = packageFixture(t);
  const stateDir = join(fixture.root, 'state');
  const record = transactionRecordPath(stateDir, fixture.prefix);
  mkdirSync(join(stateDir, 'pi-runtime-transactions'), { recursive: true });
  writeFileSync(record, JSON.stringify({
    schemaVersion: 1,
    prefix: fixture.prefix,
    backupRoot: '/old/backup',
  }));

  assert.equal(recoverIdleInstallation(fixture.prefix, {
    env: { CODA_PLUGIN_STATE: stateDir },
  }), true);
  assert.equal(existsSync(record), false);
});

test('setup recovery leaves an active update lock, owner and record intact', t => {
  const fixture = packageFixture(t);
  const stateDir = join(fixture.root, 'state');
  const owner = holdLock(fixture.prefix, process.pid);
  const record = transactionRecordPath(stateDir, fixture.prefix);
  mkdirSync(join(stateDir, 'pi-runtime-transactions'), { recursive: true });
  const recordContents = JSON.stringify({
    schemaVersion: 1,
    prefix: fixture.prefix,
    backupRoot: join(fixture.prefix, backupName, 'active'),
  });
  writeFileSync(record, recordContents);

  assert.throws(
    () => recoverIdleInstallation(fixture.prefix, {
      env: { CODA_PLUGIN_STATE: stateDir },
    }),
    /另一个 Pi 更新正在进行/,
  );
  assert.deepEqual(lockOwners(fixture.prefix), [owner]);
  assert.equal(readFileSync(record, 'utf8'), recordContents);
});

test('updateLatest upgrades the npm installation behind a recognized shell wrapper', t => {
  const fixture = packageFixture(t);
  const wrapper = join(fixture.root, 'wrapper-pi');
  writeFileSync(wrapper, [
    '#!/bin/sh',
    'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"',
    `exec ${fixture.command} "$@"`,
    '',
  ].join('\n'));
  const m = npmMachine({ aliases: { [wrapper]: fixture.command } });

  const result = updateLatest({
    env: {},
    home: fixture.root,
    node,
    run: m.run,
    find: () => wrapper,
  });
  assert.equal(result.version, '1.4.0');
  assert.equal(result.path, wrapper);
  assert.equal(result.prefix, fixture.prefix);
  assert.equal(readFileSync(fixture.cli, 'utf8'), '1.4.0\n');
});

test('recovery is a no-op when the npm prefix does not exist', () => {
  assert.equal(recoverInterruptedInstallation('/path/that/does/not/exist'), false);
});

// The layouts Homebrew's formula, Bun and pnpm leave, as observed with those tools.
function toolLayouts(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-tools-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = base => {
    const bundle = join(base, PACKAGE, 'dist/bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'cli.js'), '1.2.0\n');
    return join(bundle, 'cli.js');
  };

  const brewPrefix = join(root, 'homebrew');
  const keg = join(brewPrefix, 'Cellar/pi-coding-agent/1.2.0');
  cli(join(keg, 'libexec/lib/node_modules'));
  mkdirSync(join(keg, 'bin'), { recursive: true });
  writeFileSync(join(keg, 'bin/pi'), `#!/bin/bash\nPI_SKIP_VERSION_CHECK="1" exec "${keg}/libexec/bin/pi" "$@"\n`);
  mkdirSync(join(brewPrefix, 'bin'));
  symlinkSync('../Cellar/pi-coding-agent/1.2.0/bin/pi', join(brewPrefix, 'bin/pi'));

  const bunRoot = join(root, 'bun');
  cli(join(bunRoot, 'install/global/node_modules'));
  mkdirSync(join(bunRoot, 'bin'));
  symlinkSync(`../install/global/node_modules/${PACKAGE}/dist/bundle/cli.js`, join(bunRoot, 'bin/pi'));

  const pnpmHome = join(root, 'pnpm');
  const pnpmGroup = join(pnpmHome, 'global/v11/14c9f-1a1903cc0b1');
  const pnpmTarget = cli(join(pnpmGroup, 'node_modules'));
  writeFileSync(join(pnpmGroup, 'package.json'), JSON.stringify({ dependencies: { [PACKAGE]: '1.2.0' } }));
  mkdirSync(join(pnpmHome, 'bin'));
  writeFileSync(join(pnpmHome, 'bin/pi'), [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    'if [ -x "$basedir/node" ]; then',
    `  exec "$basedir/node"  "$basedir/../global/v11/14c9f-1a1903cc0b1/node_modules/${PACKAGE}/dist/bundle/cli.js" "$@"`,
    'else',
    `  exec node  "$basedir/../global/v11/14c9f-1a1903cc0b1/node_modules/${PACKAGE}/dist/bundle/cli.js" "$@"`,
    'fi',
    `# cmd-shim-target=${pnpmTarget}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { root, brewPrefix, bunRoot, pnpmHome, pnpmGroup };
}

test('Homebrew formula, Bun and pnpm installs are recognized from where they resolve', t => {
  const layout = toolLayouts(t);
  const owner = path => runtimeOwner(path, { env: {}, home: layout.root });

  assert.deepEqual(
    (({ kind, prefix, brew, formula }) => ({ kind, prefix, brew, formula }))(owner(join(layout.brewPrefix, 'bin/pi'))),
    { kind: 'homebrew', prefix: layout.brewPrefix, brew: join(layout.brewPrefix, 'bin/brew'), formula: 'pi-coding-agent' },
  );
  const wrapper = join(layout.root, 'wrapper-pi');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${join(layout.brewPrefix, 'bin/pi')} "$@"\n`);
  assert.equal(owner(wrapper).kind, 'homebrew');

  assert.deepEqual((({ kind, root }) => ({ kind, root }))(owner(join(layout.bunRoot, 'bin/pi'))),
    { kind: 'bun', root: layout.bunRoot });
  assert.deepEqual((({ kind, home: pnpmHome }) => ({ kind, home: pnpmHome }))(owner(join(layout.pnpmHome, 'bin/pi'))),
    { kind: 'pnpm', home: layout.pnpmHome });

  rmSync(join(layout.pnpmHome, 'global'), { recursive: true });
  assert.equal(owner(join(layout.pnpmHome, 'bin/pi')).kind, 'external');
});

test('a pre-11 pnpm shim is followed through its $basedir path', () => {
  const shim = '/Users/me/Library/pnpm/pi';
  const source = `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/global/5/node_modules/${PACKAGE}/dist/bundle/cli.js" "$@"\n`;
  assert.equal(pnpmShimTarget(shim, { readFile: () => source }),
    `/Users/me/Library/pnpm/global/5/node_modules/${PACKAGE}/dist/bundle/cli.js`);
  assert.equal(pnpmShimTarget(shim, { readFile: () => '#!/bin/sh\nexec node "$basedir/other/cli.js" "$@"\n' }), null);
});

// `pi --version` reports `before` until the tool's update command has run.
function toolMachine({ owner, latest = '1.4.0', stable = latest, before = '1.2.0', after = latest, status = 0 }) {
  const calls = [];
  let updated = false;
  const run = (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    if (command === node && args[1] === 'view') return { status: 0, stdout: JSON.stringify(latest) };
    if (args[0] === 'info') return { status: 0, stdout: JSON.stringify({ formulae: [{ versions: { stable } }] }) };
    if (args[0] === 'upgrade' || args[0] === 'add') {
      updated = status === 0;
      return { status, stderr: status ? 'tool failed' : '' };
    }
    if (args.includes('--version')) return { status: 0, stdout: updated ? after : before };
    return { status: 1 };
  };
  return { calls, run, updates: () => calls.filter(call => ['upgrade', 'add'].includes(call.args[0])) };
}

test('updateLatest upgrades a Homebrew formula with brew, to the version Homebrew offers', t => {
  const layout = toolLayouts(t);
  const command = join(layout.brewPrefix, 'bin/pi');
  const m = toolMachine({ latest: '1.5.0', stable: '1.4.0', after: '1.4.0' });
  const result = updateLatest({ env: { PATH: '/usr/bin' }, home: layout.root, node, run: m.run, find: () => command });
  assert.equal(result.version, '1.4.0');
  assert.equal(result.latest, '1.4.0');
  assert.equal(result.changed, true);
  assert.deepEqual(m.calls.filter(call => call.command !== command).map(call => [call.command, ...call.args]), [
    [join(layout.brewPrefix, 'bin/brew'), 'info', '--json=v2', 'pi-coding-agent'],
    [join(layout.brewPrefix, 'bin/brew'), 'upgrade', 'pi-coding-agent'],
  ]);

  const current = toolMachine({ before: '1.4.0' });
  assert.equal(updateLatest({ env: {}, home: layout.root, node, run: current.run, find: () => command }).changed, false);
  assert.equal(current.updates().length, 0);
});

test('updateLatest adds the exact npm latest with Bun or pnpm in their own homes', t => {
  const layout = toolLayouts(t);
  const bun = toolMachine({});
  const bunCommand = join(layout.bunRoot, 'bin/pi');
  assert.equal(updateLatest({ env: { PATH: '/usr/bin' }, home: layout.root, node, run: bun.run, find: () => bunCommand }).version, '1.4.0');
  const [bunUpdate] = bun.updates();
  assert.deepEqual([bunUpdate.command, ...bunUpdate.args], ['bun', 'add', '--global', `${PACKAGE}@1.4.0`]);
  assert.equal(bunUpdate.env.BUN_INSTALL, layout.bunRoot);
  assert.ok(bunUpdate.env.PATH.startsWith(`${join(layout.bunRoot, 'bin')}:`));

  writeFileSync(join(layout.pnpmHome, 'pnpm'), '#!/bin/sh\n', { mode: 0o755 });
  const pnpm = toolMachine({});
  const pnpmCommand = join(layout.pnpmHome, 'bin/pi');
  assert.equal(updateLatest({ env: { PATH: '/usr/bin' }, home: layout.root, node, run: pnpm.run, find: () => pnpmCommand }).version, '1.4.0');
  const [pnpmUpdate] = pnpm.updates();
  assert.deepEqual([pnpmUpdate.command, ...pnpmUpdate.args],
    [join(layout.pnpmHome, 'pnpm'), 'add', '--global', '--config.ignore-scripts=true', `${PACKAGE}@1.4.0`]);
  assert.equal(pnpmUpdate.env.PNPM_HOME, layout.pnpmHome);
  assert.ok(pnpmUpdate.env.PATH.startsWith(`${join(layout.pnpmHome, 'bin')}:${layout.pnpmHome}:`));
});

test('tool updates refuse a prerelease and fail when the tool or the result does', t => {
  const layout = toolLayouts(t);
  const command = join(layout.bunRoot, 'bin/pi');
  const update = m => () => updateLatest({ env: {}, home: layout.root, node, run: m.run, find: () => command });

  const prerelease = toolMachine({ latest: '1.5.0-beta.1' });
  assert.throws(update(prerelease), /1\.5\.0-beta\.1 不是当前插件支持的稳定版本，未更新/);
  assert.equal(prerelease.updates().length, 0);

  assert.throws(update(toolMachine({ status: 1 })), error => !(error instanceof RollbackError) && /Bun 全局安装.*更新 Pi 失败：tool failed/.test(error.message));
  assert.throws(update(toolMachine({ after: '1.2.0' })), /Pi 1\.2\.0 仍低于 npm latest 1\.4\.0/);
});

test('a pnpm 11 install group is re-added whole, keeping its other tools at their installed versions', t => {
  const layout = toolLayouts(t);
  writeFileSync(join(layout.pnpmGroup, 'package.json'), JSON.stringify({
    dependencies: { [PACKAGE]: '1.2.0', semver: '^7.6.0', local: 'file:/tools/local' },
  }));
  mkdirSync(join(layout.pnpmGroup, 'node_modules/semver'), { recursive: true });
  writeFileSync(join(layout.pnpmGroup, 'node_modules/semver/package.json'), JSON.stringify({ version: '7.8.5' }));
  const command = join(layout.pnpmHome, 'bin/pi');
  const update = m => updateLatest({ env: {}, home: layout.root, node, run: m.run, find: () => command });

  const m = toolMachine({});
  assert.equal(update(m).version, '1.4.0');
  assert.equal(m.updates()[0].args.at(-1), `${PACKAGE}@1.4.0,semver@7.8.5,local@file:/tools/local`);

  writeFileSync(join(layout.pnpmGroup, 'package.json'), JSON.stringify({
    dependencies: { [PACKAGE]: '1.2.0', odd: 'file:/a,b' },
  }));
  const comma = toolMachine({});
  assert.throws(() => update(comma), /odd@file:\/a,b 含逗号，无法与 Pi 一起重装，未更新/);
  assert.equal(comma.updates().length, 0);
});

test('a pre-11 shared pnpm global directory updates Pi alone', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-pnpm10-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'global/5/node_modules', PACKAGE, 'dist/bundle'), { recursive: true });
  writeFileSync(join(root, 'global/5/node_modules', PACKAGE, 'dist/bundle/cli.js'), '1.2.0\n');
  writeFileSync(join(root, 'global/5/package.json'), JSON.stringify({ dependencies: { [PACKAGE]: '1.2.0', other: '1.0.0' } }));
  writeFileSync(join(root, 'pi'), `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/global/5/node_modules/${PACKAGE}/dist/bundle/cli.js" "$@"\n`, { mode: 0o755 });
  const owner = runtimeOwner(join(root, 'pi'), { env: {}, home: root });
  assert.equal(owner.kind, 'pnpm');
  assert.equal(owner.group, undefined);
  const m = toolMachine({});
  updateLatest({ env: {}, home: root, node, run: m.run, find: () => join(root, 'pi') });
  assert.equal(m.updates()[0].args.at(-1), `${PACKAGE}@1.4.0`);
});
