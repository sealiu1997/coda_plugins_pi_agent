// Resolve which Pi runs. By default this plugin runs the exact Pi package installed with
// the plugin by Coda. An explicit non-"pi" pi.commandPath remains an escape hatch for an
// externally managed Pi, without PATH or common install directories silently overriding it.
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

export const PACKAGE = '@earendil-works/pi-coding-agent';
export const MIN_PI_VERSION = '1.1.0';
export const VERIFIED_PI_VERSION = '1.4.0';
export const MANAGED_PI_CLI = 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';

export const parsePiVersion = output => {
  const match = String(output ?? '').match(/\bv?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)\b/);
  return match?.[1] ?? null;
};

export function supportedVersion(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:\+[^ ]+)?$/.exec(version ?? '');
  if (!parts) return false;
  const minimum = MIN_PI_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const n = Number(parts[i + 1]);
    if (n !== minimum[i]) return n > minimum[i];
  }
  return true;
}

export function normalizePiLaunch(value) {
  if (value && typeof value === 'object' && typeof value.command === 'string') {
    return {
      command: value.command,
      prefixArgs: Array.isArray(value.prefixArgs) ? value.prefixArgs.map(String) : [],
      ...(value.cliPath ? { cliPath: String(value.cliPath) } : {}),
      kind: value.kind === 'external' ? 'external' : 'managed',
    };
  }
  return { command: String(value), prefixArgs: [], kind: 'external' };
}

export function launchLabel(value) {
  const launch = normalizePiLaunch(value);
  return launch.cliPath ?? (launch.prefixArgs.length ? `${launch.command} ${launch.prefixArgs.join(' ')}` : launch.command);
}

export function launchArgs(value, args = []) {
  const launch = normalizePiLaunch(value);
  return [...launch.prefixArgs, ...args];
}

// Resolve the launch description once at agent startup. "pi" and an empty value mean the
// plugin-managed package; every other configured value is an explicit external override.
export function resolvePiLaunch(settings = {}, {
  pluginPath = process.env.CODA_PLUGIN_PATH || '.',
  node = process.env.CODA_NODE || process.execPath,
} = {}) {
  const configured = typeof settings?.['pi.commandPath'] === 'string'
    ? settings['pi.commandPath'].trim()
    : '';
  if (configured && configured !== 'pi') {
    return { command: configured, prefixArgs: [], kind: 'external' };
  }
  const cliPath = resolve(pluginPath, MANAGED_PI_CLI);
  return { command: node, prefixArgs: [cliPath], cliPath, kind: 'managed' };
}

export function assertPiVersion(version, launch) {
  if (!supportedVersion(version)) {
    const normalized = normalizePiLaunch(launch);
    const guidance = normalized.kind === 'managed'
      ? '请更新或重新安装 Pi 插件，再在插件页重试准备运行环境'
      : '请用原安装方式升级这个 Pi，或把 pi.commandPath 改回 pi 以使用插件内置运行时';
    throw new Error(`Pi ${version ?? '版本未知'}（${launchLabel(normalized)}）不满足最低版本 ${MIN_PI_VERSION}。${guidance}。`);
  }
  return version;
}

const runFile = promisify(execFile);

const versionKey = launch => JSON.stringify([
  normalizePiLaunch(launch).command,
  normalizePiLaunch(launch).prefixArgs,
]);

// The version a Pi reports (`pi --version` prints e.g. 1.4.0), cached per launch. The
// fallback stands in when the runtime cannot run, so callers never wait or throw here.
const versionCache = new Map();
export async function piVersion(piCommand, { timeout = 5000, fallback = null } = {}) {
  const launch = normalizePiLaunch(piCommand);
  const key = versionKey(launch);
  if (!versionCache.has(key)) {
    try {
      const { stdout, stderr } = await runFile(launch.command, launchArgs(launch, ['--version']), { timeout });
      versionCache.set(key, parsePiVersion(`${stdout ?? ''}\n${stderr ?? ''}`));
    } catch (error) {
      process.stderr.write(`[pi-agent] Pi --version failed: ${error.message}\n`);
      versionCache.set(key, null);
    }
  }
  return versionCache.get(key) ?? (fallback ? await fallback() : null);
}

export function versionOf(piCommand, { env = process.env, run = spawnSync, timeout = 5_000 } = {}) {
  const launch = normalizePiLaunch(piCommand);
  const result = run(launch.command, launchArgs(launch, ['--version']), {
    encoding: 'utf8',
    timeout,
    env,
  });
  return result.status === 0
    ? parsePiVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    : null;
}
