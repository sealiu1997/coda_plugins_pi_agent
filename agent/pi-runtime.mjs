import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, normalize } from 'node:path';
import {
  PACKAGE,
  findPi,
  managedPi,
  managedPrefix,
  parsePiVersion,
  supportedVersion,
  versionOf,
} from './pi-command.mjs';

// Node distributions place npm beside or under their installation prefix. Homebrew's Node
// can use libexec while its globally installed packages still live under lib/node_modules.
export const npmCli = (node, { exists = existsSync } = {}) => {
  const dir = dirname(node);
  const candidates = [
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, 'npm'),
  ];
  return candidates.find(exists) ?? candidates[0];
};

const withNode = (env, node) => ({
  ...env,
  PATH: [dirname(node), env.PATH].filter(Boolean).join(delimiter),
});

export function compareVersions(a, b) {
  const left = String(a ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  const right = String(b ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference) return Math.sign(difference);
  }
  if (left[4] === right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  const leftParts = left[4].split('.');
  const rightParts = right[4].split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    if (leftParts[i] === undefined) return -1;
    if (rightParts[i] === undefined) return 1;
    if (leftParts[i] === rightParts[i]) continue;
    const leftNumber = /^\d+$/.test(leftParts[i]);
    const rightNumber = /^\d+$/.test(rightParts[i]);
    if (leftNumber && rightNumber) return Math.sign(Number(leftParts[i]) - Number(rightParts[i]));
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return leftParts[i] < rightParts[i] ? -1 : 1;
  }
  return 0;
}

export function latestVersion({ env = process.env, node = process.execPath, run = spawnSync, timeout = 12_000 } = {}) {
  const result = run(node, [npmCli(node), 'view', `${PACKAGE}@latest`, 'version', '--json', '--no-update-notifier'], {
    encoding: 'utf8',
    timeout,
    env: withNode(env, node),
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() || `npm view 退出码 ${result.status ?? result.signal}`);
  }
  const version = parsePiVersion(result.stdout);
  if (!version) throw new Error('npm view 没有返回版本号');
  return version;
}

// The npm prefix that owns an executable linked from `<prefix>/lib/node_modules`.
export function npmOwner(command, { realpath = realpathSync } = {}) {
  if (!command || command === 'pi') return null;
  let actual;
  try {
    actual = normalize(realpath(command)).replaceAll('\\', '/');
  } catch {
    return null;
  }
  const marker = '/lib/node_modules/@earendil-works/pi-coding-agent/';
  const at = actual.lastIndexOf(marker);
  return at > 0 ? { kind: 'npm', prefix: actual.slice(0, at), actual } : null;
}

// Resolve the narrow shell-wrapper shape used by Homebrew/npm users to forward Pi into a
// non-interactive PATH. This never executes the wrapper and rejects scripts with any other
// commands, variable targets, relative targets or multiple exec statements.
export function wrapperTarget(command, {
  realpath = realpathSync,
  readFile = readFileSync,
  depth = 0,
  seen = new Set(),
} = {}) {
  if (!command || depth >= 4) return null;
  const requested = normalize(command);
  let actual;
  try {
    actual = normalize(realpath(requested));
  } catch {
    return null;
  }
  // Symlinks are already handled by npmOwner. Only inspect a wrapper stored at the command path.
  if (actual !== requested) return null;
  if (seen.has(actual)) return null;
  seen.add(actual);

  let source;
  try {
    source = readFile(actual, 'utf8');
  } catch {
    return null;
  }
  if (typeof source !== 'string' || source.length > 64 * 1024) return null;
  const lines = source.split(/\r?\n/);
  if (!/^#!\/(?:usr\/bin\/env\s+(?:sh|bash)|bin\/(?:sh|bash))$/.test(lines[0]?.trim() ?? '')) {
    return null;
  }
  const body = lines.slice(1).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!body.length) return null;

  const execLines = body.filter(line => /^exec(?:\s|$)/.test(line));
  if (execLines.length !== 1 || body.at(-1) !== execLines[0]) return null;
  const match = /^exec\s+(\/[^\s'"]+)\s+"\$@"$/.exec(execLines[0]);
  if (!match) return null;
  const commands = body.slice(0, -1);
  const pathAssignment = /^(?:export\s+)?PATH=(?:"[^"\r\n]*"|'[^'\r\n]*'|[A-Za-z0-9_./:+@%{}$-]+)$/;
  if (commands.length > 1 || commands.some(line => !pathAssignment.test(line))) return null;

  const target = normalize(match[1]);
  return wrapperTarget(target, { realpath, readFile, depth: depth + 1, seen }) ?? target;
}

const PACKAGE_PATH = `/node_modules/${PACKAGE}/`;
const HOMEBREW_FORMULA = 'pi-coding-agent';

// The Pi a pnpm global bin shim starts, read from the shim without running it: pnpm 11 records it
// as `# cmd-shim-target=`, earlier versions only as a path below `$basedir`.
export function pnpmShimTarget(shim, { readFile = readFileSync } = {}) {
  let source;
  try {
    source = readFile(shim, 'utf8');
  } catch {
    return null;
  }
  if (typeof source !== 'string' || source.length > 64 * 1024 || !source.startsWith('#!/bin/sh')) return null;
  const recorded = /^# cmd-shim-target=(\/.+)$/m.exec(source)?.[1];
  const relative = /"\$basedir\/((?:\.\.\/)?global\/[^"]+)"/.exec(source)?.[1];
  const target = recorded ?? (relative ? join(dirname(shim), relative) : null);
  if (!target) return null;
  const path = normalize(target).replaceAll('\\', '/');
  return path.includes('/global/') && path.includes(PACKAGE_PATH) ? path : null;
}

// Homebrew's formula, Bun and pnpm keep Pi in their own layouts and update it with their own
// commands. Each is recognized from where the command resolves, never by running it.
function toolOwner(command, { realpath, readFile }) {
  let actual;
  try {
    actual = normalize(realpath(command)).replaceAll('\\', '/');
  } catch {
    return null;
  }
  const keg = actual.indexOf(`/Cellar/${HOMEBREW_FORMULA}/`);
  if (keg > 0) {
    const prefix = actual.slice(0, keg);
    return { kind: 'homebrew', prefix, brew: join(prefix, 'bin', 'brew'), formula: HOMEBREW_FORMULA, actual };
  }
  const bun = actual.indexOf(`/install/global${PACKAGE_PATH}`);
  if (bun > 0) return { kind: 'bun', root: actual.slice(0, bun), actual };
  const shim = pnpmShimTarget(actual, { readFile });
  if (shim) {
    try {
      realpath(shim);
    } catch {
      return null;
    }
    const pnpmHome = shim.slice(0, shim.indexOf('/global/'));
    // pnpm 11 keeps each install group in global/v11/<hash>; earlier versions share global/<n>.
    const installDir = shim.slice(0, shim.indexOf(PACKAGE_PATH));
    const grouped = installDir.slice(pnpmHome.length + '/global/'.length).split('/').length === 2;
    return { kind: 'pnpm', home: pnpmHome, actual: shim, ...(grouped ? { group: installDir } : {}) };
  }
  return null;
}

// Owners whose installation this plugin can update, by npm or by the tool that installed it.
export const UPDATABLE = new Set(['none', 'managed', 'npm', 'homebrew', 'bun', 'pnpm']);

// A custom executable at ~/.local/bin is external unless its symlink resolves into the npm
// package this plugin installed. That protects user scripts while still recognizing npm.
export function runtimeOwner(path, {
  env = process.env,
  home = homedir(),
  realpath = realpathSync,
  readFile = readFileSync,
} = {}) {
  if (!path || path === 'pi') return { kind: 'none' };
  const ownerPath = wrapperTarget(path, { realpath, readFile }) ?? path;
  const tool = toolOwner(ownerPath, { realpath, readFile });
  if (tool) return tool;
  const npm = npmOwner(ownerPath, { realpath });
  if (!npm) return { kind: 'external' };
  const prefix = normalize(managedPrefix(env, home)).replaceAll('\\', '/');
  let actualPrefix = prefix;
  try {
    actualPrefix = normalize(realpath(prefix)).replaceAll('\\', '/');
  } catch {}
  return npm.prefix === actualPrefix ? { ...npm, kind: 'managed' } : npm;
}

// Where an update of this owner goes, for setup's progress line.
export function updateTarget(owner, { env = process.env, home = homedir() } = {}) {
  switch (owner.kind) {
    case 'npm': return owner.prefix;
    case 'homebrew': return `Homebrew（brew upgrade ${owner.formula}）`;
    case 'bun': return `Bun 全局安装（${owner.root}）`;
    case 'pnpm': return `pnpm 全局安装（${owner.home}）`;
    default: return managedPi(env, home);
  }
}

export function inspectRuntime({
  env = process.env,
  home = homedir(),
  node = process.execPath,
  run = spawnSync,
  find = findPi,
  realpath = realpathSync,
  checkLatest = true,
} = {}) {
  let settings = {};
  try {
    settings = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}');
  } catch {}
  const path = find(settings, { env, home });
  const missing = path === 'pi';
  const version = missing ? null : versionOf(path, { env, node, run });
  const owner = runtimeOwner(missing ? null : path, { env, home, realpath });
  let latest = null;
  let latestError = null;
  if (checkLatest) {
    try {
      latest = latestVersion({ env, node, run });
    } catch (error) {
      latestError = error.message;
    }
  }
  const comparison = compareVersions(version, latest);
  return {
    path: missing ? null : path,
    version,
    latest,
    latestError,
    owner,
    updateAvailable: comparison !== null && comparison < 0,
    canUpdate: UPDATABLE.has(owner.kind),
  };
}

const packageInstallationPaths = prefix => ({
  package: join(prefix, 'lib', 'node_modules', PACKAGE),
  command: join(prefix, 'bin', 'pi'),
});
const updateLock = prefix => join(prefix, '.coda-pi-update.lock');
const backupPrefix = '.coda-pi-backup-';
const stagePrefix = '.coda-pi-stage-';
const transactionStateDir = env => env.CODA_PLUGIN_STATE
  ? join(env.CODA_PLUGIN_STATE, 'pi-runtime-transactions')
  : null;

const pathExists = path => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

// A failed rollback leaves the previous Pi in an unknown state; setup must fail instead of
// assuming the version it saw before the update is still installed.
export class RollbackError extends Error {}

const writeFileAtomic = (target, contents) => {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, target);
};

const writeTransaction = (backupRoot, transaction) => {
  writeFileAtomic(
    join(backupRoot, 'transaction.json'),
    `${JSON.stringify(transaction, null, 2)}\n`,
  );
};

const transactionRecord = (env, prefix) => {
  const root = transactionStateDir(env);
  if (!root) return null;
  const key = createHash('sha256').update(normalize(prefix)).digest('hex');
  return join(root, `${key}.json`);
};

const rememberTransaction = (env, prefix, backupRoot) => {
  const record = transactionRecord(env, prefix);
  if (!record) return;
  mkdirSync(dirname(record), { recursive: true });
  writeFileAtomic(record, `${JSON.stringify({
    schemaVersion: 1,
    prefix: normalize(prefix),
    backupRoot,
  }, null, 2)}\n`);
};

const forgetTransaction = (env, prefix) => {
  const record = transactionRecord(env, prefix);
  if (record) rmSync(record, { force: true });
};

const recordedTransactionPrefixes = env => {
  const root = transactionStateDir(env);
  if (!root || !pathExists(root)) return [];
  const prefixes = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = join(root, entry.name);
    try {
      const value = JSON.parse(readFileSync(record, 'utf8'));
      if (value?.schemaVersion !== 1 || typeof value.prefix !== 'string' || !value.prefix) {
        throw new Error('事务记录格式不支持');
      }
      prefixes.push(normalize(value.prefix));
    } catch (error) {
      throw new Error(`无法读取 Pi 更新事务记录 ${record}：${error.message}`);
    }
  }
  return [...new Set(prefixes)];
};

const readTransaction = backupRoot => {
  const manifest = join(backupRoot, 'transaction.json');
  try {
    const transaction = JSON.parse(readFileSync(manifest, 'utf8'));
    if (transaction?.schemaVersion !== 1 || !Array.isArray(transaction.states)) {
      throw new Error('事务清单格式不支持');
    }
    return transaction;
  } catch (error) {
    throw new Error(`无法读取 Pi 更新备份 ${manifest}：${error.message}`);
  }
};

const processIsAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

function cleanupFinishedBackup(backupRoot) {
  const entries = readdirSync(backupRoot);
  entries.sort((left, right) => {
    if (left === 'transaction.json') return 1;
    if (right === 'transaction.json') return -1;
    return left.localeCompare(right);
  });
  for (const entry of entries) {
    rmSync(join(backupRoot, entry), { recursive: true, force: true });
  }
  rmdirSync(backupRoot);
}

function restoreTransaction(backupRoot, transaction) {
  let firstError = null;
  for (const state of transaction.states) {
    try {
      const backup = join(backupRoot, state.name);
      const backupExists = pathExists(backup);
      if (state.existed) {
        if (backupExists) {
          rmSync(state.path, { recursive: true, force: true });
          mkdirSync(dirname(state.path), { recursive: true });
          renameSync(backup, state.path);
        } else if (state.moved && !pathExists(state.path)) {
          // A previous recovery can be interrupted after moving the backup back but before
          // persisting moved=false. Recover that state without requiring a second backup.
          throw new Error(`备份缺少 ${state.name}`);
        }
        state.moved = false;
      } else {
        rmSync(state.path, { recursive: true, force: true });
      }
      state.restored = true;
      writeTransaction(backupRoot, transaction);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

function interruptedBackups(prefix) {
  if (!pathExists(prefix)) return false;
  const backups = readdirSync(prefix, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(backupPrefix))
    .map(entry => join(prefix, entry.name))
    .sort();
  return backups;
}

export function recoverInterruptedInstallation(prefix) {
  const backups = interruptedBackups(prefix);
  if (!backups?.length) return false;
  if (backups.length > 1) {
    throw new Error(`检测到多个未完成的 Pi 更新备份，请人工检查：${backups.join(', ')}`);
  }
  const backupRoot = backups[0];
  if (!pathExists(join(backupRoot, 'transaction.json'))) {
    const payloads = readdirSync(backupRoot)
      .filter(name => !name.startsWith('transaction.json.'));
    if (payloads.length) {
      throw new Error(`Pi 更新备份缺少事务清单：${backupRoot}`);
    }
    cleanupFinishedBackup(backupRoot);
    return true;
  }
  const transaction = readTransaction(backupRoot);
  if (transaction.phase !== 'committed') {
    transaction.phase = 'rollback';
    writeTransaction(backupRoot, transaction);
    restoreTransaction(backupRoot, transaction);
  }
  cleanupFinishedBackup(backupRoot);
  return true;
}

// The lock is a directory holding exactly one `owner-<pid>-<token>` entry. It is created with
// its owner already inside, and a dead owner is replaced by renaming that exact entry. Two
// processes reclaiming the same stale lock cannot both win, and a process that read an old
// owner cannot take the lock someone else has since acquired.
const lockOwner = name => {
  const match = /^owner-(\d+)-[0-9a-f-]+$/.exec(name);
  return match ? { pid: Number(match[1]), name } : null;
};

function readLockOwner(lock) {
  let names;
  try {
    names = readdirSync(lock);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const owners = names.map(lockOwner).filter(Boolean);
  if (owners.length !== 1) {
    throw new Error(`Pi 更新锁内容无法识别，确认没有更新在进行后请删除：${lock}`);
  }
  return owners[0];
}

// Only the lock holder runs here, so stages and backups belong to dead updaters. Lock drafts
// may belong to a live process that is about to try the lock, so only dead ones are removed.
function removeLeftovers(prefix, lock, alive) {
  const lockName = lock.slice(prefix.length + 1);
  for (const name of readdirSync(prefix)) {
    const draft = name.startsWith(`${lockName}.new-`) && /^\d+/.exec(name.slice(lockName.length + 5));
    if (name.startsWith(stagePrefix)
      || name.startsWith(`${lockName}.released-`)
      || (draft && !alive(Number(draft[0])))) {
      rmSync(join(prefix, name), { recursive: true, force: true });
    }
  }
}

export function acquireUpdateLock(prefix, { env = process.env, alive = processIsAlive } = {}) {
  mkdirSync(prefix, { recursive: true });
  const lock = updateLock(prefix);
  const mine = `owner-${process.pid}-${randomUUID()}`;
  let acquired = false;
  for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
    const draft = mkdtempSync(`${lock}.new-${process.pid}-`);
    try {
      writeFileSync(join(draft, mine), '');
      renameSync(draft, lock);
      acquired = true;
      continue;
    } catch (error) {
      rmSync(draft, { recursive: true, force: true });
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    }
    const owner = readLockOwner(lock);
    if (!owner) continue;
    if (alive(owner.pid)) throw new Error(`另一个 Pi 更新正在进行（PID ${owner.pid}）：${lock}`);
    try {
      renameSync(join(lock, owner.name), join(lock, mine));
      acquired = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!acquired) throw new Error(`无法取得 Pi 更新锁：${lock}`);
  const release = () => {
    if (!pathExists(join(lock, mine))) return;
    const released = `${lock}.released-${process.pid}-${randomUUID()}`;
    renameSync(lock, released);
    rmSync(released, { recursive: true, force: true });
  };
  try {
    removeLeftovers(prefix, lock, alive);
    recoverInterruptedInstallation(prefix);
    forgetTransaction(env, prefix);
  } catch (error) {
    release();
    // The backup stays in the prefix for the next attempt or for inspection.
    throw new RollbackError(`${error.message}；未完成备份保留在 ${prefix}`, { cause: error });
  }
  return release;
}

const hasLeftovers = prefix => pathExists(prefix) && readdirSync(prefix).some(name => (
  name.startsWith(backupPrefix) || name.startsWith(stagePrefix) || name.startsWith('.coda-pi-update.lock')
));

// Setup uses this to clean an interrupted transaction without creating lock files on every
// ordinary launch. If another process is still updating, its live pid lock is reported instead.
export function recoverIdleInstallation(prefix, { env = process.env } = {}) {
  const record = transactionRecord(env, prefix);
  if (!hasLeftovers(prefix) && !(record && pathExists(record))) return false;
  acquireUpdateLock(prefix, { env })();
  return true;
}

export function recoverPendingInstallation({ env = process.env } = {}) {
  let recovered = false;
  for (const prefix of recordedTransactionPrefixes(env)) {
    recovered = recoverIdleInstallation(prefix, { env }) || recovered;
  }
  return recovered;
}

const rollBack = (error, restore) => {
  try {
    restore();
  } catch (restoreError) {
    throw new RollbackError(`${error.message}；恢复原 Pi 安装失败：${restoreError.message}`, { cause: error });
  }
  throw error;
};

// Move the current package and command aside before the verified stage replaces them. The
// manifest lets the next lock holder restore them if this process dies before committing.
function backupInstallation(prefix, { env = process.env } = {}) {
  const backupRoot = mkdtempSync(join(prefix, backupPrefix));
  const transaction = {
    schemaVersion: 1,
    phase: 'backup',
    states: Object.entries(packageInstallationPaths(prefix)).map(([name, path]) => ({
      name,
      path,
      existed: pathExists(path),
      moved: false,
      restored: false,
    })),
  };
  const restore = () => {
    try {
      transaction.phase = 'rollback';
      writeTransaction(backupRoot, transaction);
      restoreTransaction(backupRoot, transaction);
    } catch (error) {
      throw new Error(`${error.message}；未完成备份保留在 ${backupRoot}`);
    }
    cleanupFinishedBackup(backupRoot);
    forgetTransaction(env, prefix);
  };

  try {
    writeTransaction(backupRoot, transaction);
    rememberTransaction(env, prefix, backupRoot);
    for (const state of transaction.states) {
      if (!state.existed) continue;
      renameSync(state.path, join(backupRoot, state.name));
      state.moved = true;
      writeTransaction(backupRoot, transaction);
    }
    transaction.phase = 'install';
    writeTransaction(backupRoot, transaction);
  } catch (error) {
    rollBack(error, restore);
  }

  return {
    restore,
    commit() {
      transaction.phase = 'committed';
      writeTransaction(backupRoot, transaction);
      try {
        cleanupFinishedBackup(backupRoot);
        forgetTransaction(env, prefix);
      } catch {
        // The new installation has already run and passed verification. Keep the committed
        // backup for the next lock holder to clean instead of turning success into a rollback.
      }
    },
  };
}

const checkInstalled = (version, path, latest) => {
  if (!version) throw new Error(`安装完成，但 ${path} 无法运行`);
  const comparison = compareVersions(version, latest);
  if (comparison === null || comparison < 0) {
    throw new Error(`安装完成，但 Pi ${version} 仍低于 npm latest ${latest}`);
  }
  if (!supportedVersion(version)) {
    throw new Error(`安装完成，但 Pi ${version} 不是当前插件支持的稳定版本`);
  }
  return version;
};

// npm writes only into a fresh stage beside the real installation. If setup dies while npm keeps
// running, that orphan can only touch the stage. The real package and command change by renames
// in this process, after the staged Pi has run.
function installStaged({ prefix, latest, verificationPath, env, node, run }) {
  const stage = mkdtempSync(join(prefix, stagePrefix));
  try {
    const result = run(node, [
      npmCli(node), 'install', '--global', '--prefix', stage, '--ignore-scripts',
      '--no-fund', '--no-audit', '--no-update-notifier', `${PACKAGE}@${latest}`,
    ], {
      encoding: 'utf8',
      timeout: 8 * 60_000,
      env: withNode(env, node),
    });
    if (result.status !== 0) {
      throw new Error(`安装 Pi 失败：${result.error?.message || result.stderr?.trim() || `npm 退出码 ${result.status ?? result.signal}`}`);
    }
    const staged = packageInstallationPaths(stage);
    checkInstalled(versionOf(staged.command, { env, node, run }), staged.command, latest);

    const target = packageInstallationPaths(prefix);
    const installation = backupInstallation(prefix, { env });
    try {
      mkdirSync(dirname(target.package), { recursive: true });
      mkdirSync(dirname(target.command), { recursive: true });
      renameSync(staged.package, target.package);
      renameSync(staged.command, target.command);
      const version = checkInstalled(versionOf(verificationPath, { env, node, run }), verificationPath, latest);
      installation.commit();
      return version;
    } catch (error) {
      rollBack(error, installation.restore);
    }
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      // The next lock holder removes leftover stages.
    }
  }
}

const TOOLS = new Set(['homebrew', 'bun', 'pnpm']);
const firstExisting = (paths, fallback) => paths.find(path => existsSync(path)) ?? fallback;

// The version Homebrew would upgrade the formula to.
export function homebrewLatest(owner, { env = process.env, run = spawnSync, timeout = 60_000 } = {}) {
  const result = run(owner.brew, ['info', '--json=v2', owner.formula], {
    encoding: 'utf8',
    timeout,
    env: { ...env, HOMEBREW_NO_ENV_HINTS: '1' },
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() || `brew info 退出码 ${result.status ?? result.signal}`);
  }
  let version;
  try {
    version = JSON.parse(result.stdout).formulae?.[0]?.versions?.stable;
  } catch {}
  if (!version) throw new Error(`brew info 没有给出 ${owner.formula} 的版本`);
  return version;
}

// pnpm 11 replaces every install group that contains a package it adds, so Pi alone would take
// the group's other tools with it. Re-add the whole group: Pi at `spec`, the others as installed.
function pnpmGroupSpec(owner, spec) {
  if (!owner.group) return spec;
  const manifest = JSON.parse(readFileSync(join(owner.group, 'package.json'), 'utf8'));
  const members = [spec];
  for (const [alias, wanted] of Object.entries(manifest.dependencies ?? {})) {
    if (alias === PACKAGE) continue;
    // A registry range is pinned to what is installed; file:, git, npm: and other specs stay as written.
    const registry = typeof wanted === 'string' && !wanted.includes(':') && !/^[./~]/.test(wanted);
    const version = registry
      ? JSON.parse(readFileSync(join(owner.group, 'node_modules', alias, 'package.json'), 'utf8')).version
      : wanted;
    const member = `${alias}@${version}`;
    if (member.includes(',')) throw new Error(`pnpm 安装组里的 ${member} 含逗号，无法与 Pi 一起重装，未更新`);
    members.push(member);
  }
  return members.join(',');
}

// The command that makes the tool which installed Pi put `latest` in place.
function toolCommand(owner, latest, { env, node }) {
  const spec = `${PACKAGE}@${latest}`;
  const path = directories => [...directories, dirname(node), env.PATH].filter(Boolean).join(delimiter);
  switch (owner.kind) {
    case 'homebrew':
      return {
        command: owner.brew,
        args: ['upgrade', owner.formula],
        env: { ...env, HOMEBREW_NO_ENV_HINTS: '1' },
      };
    case 'bun':
      return {
        command: firstExisting([join(owner.root, 'bin', 'bun')], 'bun'),
        args: ['add', '--global', spec],
        env: { ...env, BUN_INSTALL: owner.root, PATH: path([join(owner.root, 'bin')]) },
      };
    case 'pnpm':
      return {
        command: firstExisting([join(owner.home, 'pnpm'), join(owner.home, 'bin', 'pnpm')], 'pnpm'),
        // pnpm's own build policy applies, so builds the user approved for the group's other
        // tools (allowBuilds) run again as they did when the group was installed.
        args: ['add', '--global', pnpmGroupSpec(owner, spec)],
        env: { ...env, PNPM_HOME: owner.home, PATH: path([join(owner.home, 'bin'), owner.home]) },
      };
  }
  throw new Error(`不支持的安装方式：${owner.kind}`);
}

// Homebrew, Bun and pnpm replace their own installation and keep it consistent with their
// records, so Pi is updated through them rather than by moving files they own.
function updateWithTool(before, { env, home, node, run, realpath }) {
  const { owner } = before;
  const label = updateTarget(owner, { env, home });
  const latest = owner.kind === 'homebrew'
    ? homebrewLatest(owner, { env, run })
    : latestVersion({ env, node, run });
  const comparison = compareVersions(before.version, latest);
  if (comparison !== null && comparison >= 0) {
    return { ...before, latest, changed: false, installed: false };
  }
  // There is no rollback for another tool's installation: refuse a target this plugin cannot run.
  if (!supportedVersion(latest)) {
    throw new Error(`${label} 的最新版 ${latest} 不是当前插件支持的稳定版本，未更新`);
  }
  const { command, args, env: toolEnv } = toolCommand(owner, latest, { env, node });
  const result = run(command, args, { encoding: 'utf8', timeout: 8 * 60_000, env: toolEnv });
  if (result.status !== 0) {
    throw new Error(`${label} 更新 Pi 失败：${result.error?.message || result.stderr?.trim() || `退出码 ${result.status ?? result.signal}`}`);
  }
  const version = checkInstalled(versionOf(before.path, { env, node, run }), before.path, latest);
  return {
    path: before.path,
    version,
    latest,
    latestError: null,
    owner: runtimeOwner(before.path, { env, home, realpath }),
    updateAvailable: false,
    canUpdate: true,
    installed: false,
    changed: before.version !== version,
  };
}

export function updateLatest({
  env = process.env,
  home = homedir(),
  node = process.execPath,
  run = spawnSync,
  realpath = realpathSync,
  find = findPi,
} = {}) {
  const before = inspectRuntime({ env, home, node, run, realpath, find, checkLatest: false });
  if (TOOLS.has(before.owner.kind)) return updateWithTool(before, { env, home, node, run, realpath });
  const prefix = before.owner.kind === 'none' || before.owner.kind === 'managed'
    ? managedPrefix(env, home)
    : before.owner.kind === 'npm' ? before.owner.prefix : null;
  if (!prefix) {
    const suffix = before.path ? `：${before.path}` : '';
    throw new Error(`Pi 来自无法自动升级的安装方式${suffix}。请用原来的安装工具升级，或在 pi.commandPath 中改为 npm、Homebrew、Bun 或 pnpm 安装的 Pi`);
  }
  const latest = latestVersion({ env, node, run });
  const comparison = compareVersions(before.version, latest);
  if (comparison !== null && comparison >= 0) {
    return {
      ...before,
      latest,
      changed: false,
      installed: false,
      prefix,
    };
  }
  // Verify the command that was found, so a wrapper or symlink that will be launched is what passes.
  const verificationPath = before.path ?? managedPi(env, home);
  const release = acquireUpdateLock(prefix, { env });
  let version;
  try {
    version = installStaged({ prefix, latest, verificationPath, env, node, run });
  } finally {
    release();
  }
  return {
    path: verificationPath,
    version,
    latest,
    latestError: null,
    owner: runtimeOwner(verificationPath, { env, home, realpath }),
    updateAvailable: false,
    canUpdate: true,
    prefix,
    installed: before.owner.kind === 'none',
    changed: before.version !== version,
  };
}
