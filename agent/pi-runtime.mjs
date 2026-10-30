import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  legacyManagedPi,
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

// A custom executable at ~/.local/bin is external unless its symlink resolves into the npm
// package this plugin installed. That protects user scripts while still recognizing npm.
export function runtimeOwner(path, {
  env = process.env,
  home = homedir(),
  realpath = realpathSync,
  readFile = readFileSync,
} = {}) {
  if (!path || path === 'pi') return { kind: 'none' };
  if (path === legacyManagedPi(env)) return { kind: 'managed' };
  const ownerPath = wrapperTarget(path, { realpath, readFile }) ?? path;
  const npm = npmOwner(ownerPath, { realpath });
  if (!npm) return { kind: 'external' };
  const prefix = normalize(managedPrefix(env, home)).replaceAll('\\', '/');
  let actualPrefix = prefix;
  try {
    actualPrefix = normalize(realpath(prefix)).replaceAll('\\', '/');
  } catch {}
  return npm.prefix === actualPrefix ? { ...npm, kind: 'managed' } : npm;
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
    canUpdate: owner.kind === 'none' || owner.kind === 'managed' || owner.kind === 'npm',
  };
}

const packageInstallationPaths = prefix => ({
  package: join(prefix, 'lib', 'node_modules', PACKAGE),
  command: join(prefix, 'bin', 'pi'),
  lock: join(prefix, 'lib', 'node_modules', '.package-lock.json'),
});
const updateLock = prefix => join(prefix, '.coda-pi-update.lock');
const backupPrefix = '.coda-pi-backup-';
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

function acquireUpdateLock(prefix, { env = process.env } = {}) {
  mkdirSync(prefix, { recursive: true });
  const lock = updateLock(prefix);
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };
  const createLock = () => {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner));
  };
  const staleLocks = [];
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
    try {
      createLock();
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing = null;
      try {
        existing = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
      } catch {}
      if (processIsAlive(existing?.pid)) {
        throw new Error(`另一个 Pi 更新正在进行（PID ${existing.pid}）：${lock}`);
      }
      // Avoid taking a lock another process has created but has not populated yet.
      if (!existing) {
        try {
          if (Date.now() - lstatSync(lock).mtimeMs < 10_000) {
            throw new Error(`另一个 Pi 更新正在初始化：${lock}`);
          }
        } catch (statError) {
          if (statError.message.startsWith('另一个 Pi 更新')) throw statError;
        }
      }
      const stale = `${lock}.stale-${owner.pid}-${owner.token}-${attempt}`;
      try {
        renameSync(lock, stale);
        staleLocks.push(stale);
      } catch (renameError) {
        if (renameError.code !== 'ENOENT') throw renameError;
      }
    }
  }
  if (!acquired) throw new Error(`无法取得 Pi 更新锁：${lock}`);
  for (const stale of staleLocks) {
    try { rmSync(stale, { recursive: true, force: true }); } catch {}
  }
  try {
    recoverInterruptedInstallation(prefix);
    forgetTransaction(env, prefix);
  } catch (recoveryError) {
    // Keep both the backup and lock. A failed restore must be inspectable and must block a new
    // npm install from overwriting the remaining recovery evidence.
    throw new Error(`${recoveryError.message}；未完成备份保留在 ${prefix}`);
  }
  return () => {
    let current = null;
    try {
      current = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
    } catch {}
    if (current?.token === owner.token) rmSync(lock, { recursive: true, force: true });
  };
}

// Setup uses this to clean an interrupted transaction without creating lock files on every
// ordinary launch. If another process is still updating, its live pid lock is reported instead.
export function recoverIdleInstallation(prefix, { env = process.env } = {}) {
  const hasBackups = (interruptedBackups(prefix)?.length ?? 0) > 0;
  if (!hasBackups && !pathExists(updateLock(prefix))) {
    forgetTransaction(env, prefix);
    return false;
  }
  const releaseLock = acquireUpdateLock(prefix, { env });
  releaseLock();
  return true;
}

export function recoverPendingInstallation({ env = process.env } = {}) {
  let recovered = false;
  for (const prefix of recordedTransactionPrefixes(env)) {
    recovered = recoverIdleInstallation(prefix, { env }) || recovered;
  }
  return recovered;
}

// npm can return non-zero after changing a global prefix, and a syntactically successful install
// can still leave an unusable entrypoint. Keep the previous package, command and npm lockfile in
// the same filesystem and restore them when installation or verification fails.
function backupInstallation(prefix, { env = process.env } = {}) {
  const releaseLock = acquireUpdateLock(prefix, { env });
  let backupRoot;
  let transaction;
  try {
    backupRoot = mkdtempSync(join(prefix, backupPrefix));
    const paths = packageInstallationPaths(prefix);
    transaction = {
      schemaVersion: 1,
      phase: 'backup',
      states: Object.entries(paths).map(([name, path]) => ({
        name,
        path,
        existed: pathExists(path),
        moved: false,
        restored: false,
      })),
    };
  } catch (error) {
    releaseLock();
    throw error;
  }
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
    releaseLock();
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
    try {
      restore();
    } catch (restoreError) {
      throw new Error(`${error.message}；恢复原 Pi 安装失败：${restoreError.message}`);
    }
    throw error;
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
        // backup for the next setup run to clean instead of turning success into a rollback.
      }
      try { releaseLock(); } catch {}
    },
  };
}

export function updateLatest({
  env = process.env,
  home = homedir(),
  node = process.execPath,
  run = spawnSync,
  realpath = realpathSync,
  find = findPi,
  backup = backupInstallation,
} = {}) {
  const before = inspectRuntime({ env, home, node, run, realpath, find, checkLatest: false });
  const prefix = before.owner.kind === 'none' || before.owner.kind === 'managed'
    ? managedPrefix(env, home)
    : before.owner.kind === 'npm' ? before.owner.prefix : null;
  if (!prefix) {
    const suffix = before.path ? `：${before.path}` : '';
    throw new Error(`Pi 来自无法自动升级的安装方式${suffix}。请用原来的安装工具升级，或在 pi.commandPath 中改为 npm 安装的 Pi`);
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
  const verificationPath = before.owner.kind === 'none' || before.owner.kind === 'managed'
    ? managedPi(env, home)
    : before.path;
  const installation = backup(prefix, { env });
  let version;
  try {
    const result = run(node, [
      npmCli(node), 'install', '--global', '--prefix', prefix, '--ignore-scripts',
      '--no-fund', '--no-audit', '--no-update-notifier', `${PACKAGE}@${latest}`,
    ], {
      encoding: 'utf8',
      timeout: 8 * 60_000,
      env: withNode(env, node),
    });
    if (result.status !== 0) {
      throw new Error(`安装 Pi 失败：${result.error?.message || result.stderr?.trim() || `npm 退出码 ${result.status ?? result.signal}`}`);
    }

    version = versionOf(verificationPath, { env, node, run });
    if (!version) throw new Error(`安装完成，但 ${verificationPath} 无法运行`);
    const afterComparison = compareVersions(version, latest);
    if (afterComparison === null || afterComparison < 0) {
      throw new Error(`安装完成，但 Pi ${version} 仍低于 npm latest ${latest}`);
    }
    if (!supportedVersion(version)) {
      throw new Error(`安装完成，但 Pi ${version} 不是当前插件支持的稳定版本`);
    }
    installation.commit();
  } catch (error) {
    try {
      installation.restore();
    } catch (restoreError) {
      throw new Error(`${error.message}；恢复原 Pi 安装失败：${restoreError.message}`);
    }
    throw error;
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
