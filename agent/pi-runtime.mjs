import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, normalize } from 'node:path';
import { findPi, legacyManagedPi, managedPi, managedPrefix, PACKAGE, parsePiVersion } from './pi-command.mjs';

// Node distributions put npm beside or under their installation prefix. Homebrew in particular uses
// libexec for Node's bundled npm and a separate lib/node_modules for globally installed packages.
export const npmCli = (node, { exists = existsSync } = {}) => {
  const dir = dirname(node);
  const candidates = [
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, 'npm')
  ];
  return candidates.find(exists) ?? candidates[0];
};
const withNode = (env, node) => ({ ...env, PATH: [dirname(node), env.PATH].filter(Boolean).join(delimiter) });

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
  const leftParts = left[4].split('.'), rightParts = right[4].split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    if (leftParts[i] === undefined) return -1;
    if (rightParts[i] === undefined) return 1;
    if (leftParts[i] === rightParts[i]) continue;
    const leftNumber = /^\d+$/.test(leftParts[i]), rightNumber = /^\d+$/.test(rightParts[i]);
    if (leftNumber && rightNumber) return Math.sign(Number(leftParts[i]) - Number(rightParts[i]));
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return leftParts[i] < rightParts[i] ? -1 : 1;
  }
  return 0;
}

export function versionOf(command, { env = process.env, node = process.execPath, run = spawnSync, timeout = 5_000 } = {}) {
  const result = run(command, ['--version'], { encoding: 'utf8', timeout, env: withNode(env, node) });
  return result.status === 0 ? parsePiVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`) : null;
}

export function latestVersion({ env = process.env, node = process.execPath, run = spawnSync, timeout = 12_000 } = {}) {
  const result = run(node, [npmCli(node), 'view', `${PACKAGE}@latest`, 'version', '--json', '--no-update-notifier'], {
    encoding: 'utf8', timeout, env: withNode(env, node)
  });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || `npm view 退出码 ${result.status ?? result.signal}`);
  const version = parsePiVersion(result.stdout);
  if (!version) throw new Error('npm view 没有返回版本号');
  return version;
}

// The npm prefix that owns an executable linked from `<prefix>/lib/node_modules`. Coda's managed
// copy and npm global installs both have this layout, which makes an explicit upgrade safe.
export function npmOwner(command, { realpath = realpathSync } = {}) {
  if (!command || command === 'pi') return null;
  let actual;
  try { actual = normalize(realpath(command)).replaceAll('\\', '/'); }
  catch { return null; }
  const marker = '/lib/node_modules/@earendil-works/pi-coding-agent/';
  const at = actual.lastIndexOf(marker);
  return at > 0 ? { kind: 'npm', prefix: actual.slice(0, at), actual } : null;
}

// A managed copy must be the package we installed, not merely a file at our preferred path. A
// user's own script or symlink at ~/.local/bin/pi therefore remains an external installation.
export function runtimeOwner(path, { env = process.env, home = homedir(), realpath = realpathSync } = {}) {
  if (!path || path === 'pi') return { kind: 'none' };
  if (path === legacyManagedPi(env)) return { kind: 'managed' };
  const npm = npmOwner(path, { realpath });
  if (!npm) return { kind: 'external' };
  const prefix = normalize(managedPrefix(env, home)).replaceAll('\\', '/');
  let actualPrefix = prefix;
  try { actualPrefix = normalize(realpath(prefix)).replaceAll('\\', '/'); } catch {}
  return npm.prefix === actualPrefix ? { ...npm, kind: 'managed' } : npm;
}

export function inspectRuntime({ env = process.env, home = homedir(), node = process.execPath, run = spawnSync,
  find = findPi, realpath = realpathSync, checkLatest = true } = {}) {
  let settings = {};
  try { settings = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}'); } catch {}
  const path = find(settings, { env, home });
  const missing = path === 'pi';
  const version = missing ? null : versionOf(path, { env, node, run });
  const owner = runtimeOwner(missing ? null : path, { env, home, realpath });
  let latest = null, latestError = null;
  if (checkLatest) {
    try { latest = latestVersion({ env, node, run }); }
    catch (error) { latestError = error.message; }
  }
  const comparison = compareVersions(version, latest);
  return {
    path: missing ? null : path,
    version,
    latest,
    latestError,
    owner,
    updateAvailable: comparison !== null && comparison < 0,
    canUpdate: owner.kind === 'none' || owner.kind === 'managed' || owner.kind === 'npm'
  };
}

export function updateLatest({ env = process.env, home = homedir(), node = process.execPath, run = spawnSync,
  realpath = realpathSync, find = findPi } = {}) {
  const before = inspectRuntime({ env, home, node, run, realpath, find, checkLatest: false });
  const prefix = before.owner.kind === 'none' || before.owner.kind === 'managed'
    ? managedPrefix(env, home)
    : before.owner.kind === 'npm' ? before.owner.prefix : null;
  if (!prefix) {
    const suffix = before.path ? `：${before.path}` : '';
    throw new Error(`Pi 来自无法自动升级的安装方式${suffix}。请用它的安装工具升级，或在 pi.commandPath 中指向 npm 安装的 Pi`);
  }
  const result = run(node, [npmCli(node), 'install', '--global', '--prefix', prefix, '--ignore-scripts',
    '--no-fund', '--no-audit', '--no-update-notifier', `${PACKAGE}@latest`], {
    encoding: 'utf8', timeout: 10 * 60_000, env: withNode(env, node)
  });
  if (result.status !== 0) {
    throw new Error(`安装 Pi 失败：${result.error?.message || result.stderr?.trim() || `npm 退出码 ${result.status ?? result.signal}`}`);
  }
  // Verify the copy just installed, even if PATH or a legacy state copy still resolves first.
  const verificationPath = before.owner.kind === 'none' || before.owner.kind === 'managed'
    ? managedPi(env, home)
    : before.path;
  const version = versionOf(verificationPath, { env, node, run });
  if (!version) throw new Error(`安装完成，但 ${verificationPath} 无法运行`);
  return {
    path: verificationPath,
    version,
    latest: null,
    latestError: null,
    owner: runtimeOwner(verificationPath, { env, home, realpath }),
    updateAvailable: false,
    canUpdate: true,
    prefix,
    installed: before.owner.kind === 'none',
    changed: before.version !== version
  };
}
