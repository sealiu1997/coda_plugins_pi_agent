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
import { managedPi, managedPrefix, PACKAGE, versionOf } from '../agent/pi-command.mjs';
import {
  RollbackError,
  acquireUpdateLock,
  compareVersions,
  inspectRuntime,
  latestVersion,
  npmCli,
  npmOwner,
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
