import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, normalize } from 'node:path';
import { findPi, legacyManagedPi, managedPi, managedPrefix, PACKAGE, parsePiVersion } from './pi-command.mjs';

// Node distributions put npm beside or under their installation prefix. Homebrew in particular uses
// libexec for Node's bundled npm and a separate lib/node_modules for globally installed packages.
export const npmCli = node => {
  const dir = dirname(node);
  const candidates = [
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, 'npm')
  ];
  return candidates.find(existsSync) ?? candidates[0];
};
const withNode = (env, node) => ({ ...env, PATH: [dirname(node), env.PATH].filter(Boolean).join(delimiter) });

export function compareVersions(a, b) {
  const left = String(a ?? '').match(/^(\d+)\.(\d+)\.(\d+)/);
  const right = String(b ?? '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function versionOf(command, { env = process.env, node = process.execPath, run = spawnSync, timeout = 20_000 } = {}) {
  const result = run(command, ['--version'], { encoding: 'utf8', timeout, env: withNode(env, node) });
  return result.status === 0 ? parsePiVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`) : null;
}

export function latestVersion({ env = process.env, node = process.execPath, run = spawnSync, timeout = 20_000 } = {}) {
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

export function inspectRuntime({ env = process.env, home = homedir(), node = process.execPath, run = spawnSync,
  find = findPi, realpath = realpathSync, checkLatest = true } = {}) {
  let settings = {};
  try { settings = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}'); } catch {}
  const path = find(settings, { env, home });
  const missing = path === 'pi';
  const version = missing ? null : versionOf(path, { env, node, run });
  const own = managedPi(env, home), legacy = legacyManagedPi(env);
  const owner = missing ? { kind: 'none' } : path === own || path === legacy
    ? { kind: 'managed' }
    : npmOwner(path, { realpath }) ?? { kind: 'external' };
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
  const after = inspectRuntime({ env, home, node, run, realpath, find, checkLatest: false });
  if (!after.version) throw new Error(`安装完成，但 ${managedPi(env, home)} 无法运行`);
  return { ...after, prefix, installed: before.owner.kind === 'none', changed: before.version !== after.version };
}
