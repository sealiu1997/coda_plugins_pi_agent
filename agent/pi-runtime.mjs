import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
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

const pathExists = path => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};

// npm can return non-zero after changing a global prefix, and a syntactically successful install
// can still leave an unusable entrypoint. Keep the previous package, command and npm lockfile in
// the same filesystem and restore them when installation or verification fails.
function backupInstallation(prefix) {
  mkdirSync(prefix, { recursive: true });
  const backupRoot = mkdtempSync(join(prefix, '.coda-pi-backup-'));
  const paths = packageInstallationPaths(prefix);
  const restore = () => {
    let firstError = null;
    for (const [name, path] of Object.entries(paths)) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        firstError ??= error;
      }
      const backup = join(backupRoot, name);
      if (!pathExists(backup)) continue;
      try {
        mkdirSync(dirname(path), { recursive: true });
        renameSync(backup, path);
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      rmSync(backupRoot, { recursive: true, force: true });
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  };

  try {
    for (const [name, path] of Object.entries(paths)) {
      if (!pathExists(path)) continue;
      const backup = join(backupRoot, name);
      renameSync(path, backup);
    }
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
      rmSync(backupRoot, { recursive: true, force: true });
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
  const installation = backup(prefix);
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
