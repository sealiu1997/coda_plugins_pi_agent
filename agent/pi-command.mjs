// Where Pi is on this machine, as the agent starts it and as its setup looks for it: the path set in Coda
// (`pi.commandPath`), else the PATH, else the usual install directories, else the copy this plugin's setup installed in
// its own state (`agent/setup.mjs`). A Pi the machine has of its own is always taken before that copy.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const MIN_PI_VERSION = '1.1.0';
export const VERIFIED_PI_VERSION = MIN_PI_VERSION;

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
export function assertPiVersion(version, command) {
  if (!supportedVersion(version)) throw new Error(`Pi ${version ?? '版本未知'}（${command}）不满足最低版本 ${MIN_PI_VERSION}。请在 Pi 运行时的“更新到最新版”里升级，或执行 npm i -g ${PACKAGE}@latest；也可以将 pi.commandPath 改回 pi 后重新准备运行环境。`);
  return version;
}

export const PACKAGE = '@earendil-works/pi-coding-agent';

// The npm prefix setup owns: the user's expected ~/.local/bin, overridable for tests and managed hosts.
export const managedPrefix = (env = process.env, home = homedir()) => env.CODA_PI_PREFIX || join(home, '.local');

// The Pi this plugin installed itself: where the agent looks for it here and where setup installs and repairs it.
export const managedPi = (env = process.env, home = homedir()) => join(managedPrefix(env, home), 'bin', 'pi');

// Versions before 0.4 installed under the plugin state; keep finding them during migration.
export const legacyManagedPi = (env = process.env) => env.CODA_PLUGIN_STATE ? join(env.CODA_PLUGIN_STATE, 'pi', 'node_modules', '.bin', 'pi') : null;

const isExecutableFile = path => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function findPi(settings, { env = process.env, home = homedir(), usable = isExecutableFile } = {}) {
  const configured = settings['pi.commandPath'];
  if (configured && configured !== 'pi') return configured;
  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'pi')).find(usable);
  if (onPath) return onPath;
  const own = managedPi(env, home);
  return [join(home, '.npm-global/bin/pi'), '/opt/homebrew/bin/pi', '/usr/local/bin/pi', join(home, '.local/bin/pi'), join(home, '.bun/bin/pi'),
    ...(own ? [own, legacyManagedPi(env)] : [])].find(usable) ?? 'pi';
}

const runFile = promisify(execFile);

// The version a Pi reports (`pi --version` prints e.g. 1.1.0), cached per command. `fallback` stands in
// (its result is not cached) when the binary cannot be run, so callers never wait or throw on this.
const versionCache = new Map();
export async function piVersion(piCommand, { timeout = 5000, fallback = null } = {}) {
  if (!versionCache.has(piCommand)) {
    try {
      const { stdout } = await runFile(piCommand, ['--version'], { timeout });
      versionCache.set(piCommand, parsePiVersion(stdout));
    } catch (e) {
      process.stderr.write(`[pi-agent] pi --version failed: ${e.message}\n`);
      versionCache.set(piCommand, null);
    }
  }
  return versionCache.get(piCommand) ?? (fallback ? await fallback() : null);
}
