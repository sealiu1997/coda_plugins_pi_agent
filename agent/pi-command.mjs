// Find and describe the Pi installed on this machine. An explicit pi.commandPath wins;
// otherwise prefer PATH and the usual npm/Homebrew/Bun install locations. The plugin never
// silently substitutes a private runtime for an installation the machine already has.
import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export const PACKAGE = '@earendil-works/pi-coding-agent';
export const MIN_PI_VERSION = '1.1.0';
export const VERIFIED_PI_VERSION = '1.4.0';

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
      kind: value.kind === 'managed' ? 'managed' : 'external',
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

// Keep Pi's own bin directory and Coda's Node on PATH. This matters when Pi was found in an
// nvm/fnm/asdf directory that Coda itself did not inherit.
export function envForPiCommand(env, piCommand, node = process.execPath) {
  const next = { ...env };
  const parts = (next.PATH || '').split(delimiter).filter(Boolean);
  const command = normalizePiLaunch(piCommand).command;
  for (const directory of [isAbsolute(command) ? dirname(command) : null, dirname(node)]) {
    if (directory && !parts.includes(directory)) parts.unshift(directory);
  }
  next.PATH = [...new Set(parts)].join(delimiter);
  return next;
}

// The npm prefix this plugin owns when Pi is absent. Keeping it under ~/.local makes the
// installed command the same kind of global npm package a user would recognize.
export const managedPrefix = (env = process.env, home = homedir()) => env.CODA_PI_PREFIX || join(home, '.local');
export const managedPi = (env = process.env, home = homedir()) => join(managedPrefix(env, home), 'bin', 'pi');

// Versions before 0.4 ran `npm install --global --prefix $CODA_PLUGIN_STATE/pi`. Keep finding that
// copy; it is an ordinary npm prefix, so it is verified and updated where it is.
export const legacyManagedPi = (env = process.env) => env.CODA_PLUGIN_STATE
  ? join(env.CODA_PLUGIN_STATE, 'pi', 'bin', 'pi')
  : null;

const isExecutableFile = path => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const versionDirectories = (root, suffix, read = readdirSync) => {
  try {
    return read(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(version => join(root, version, ...suffix, 'pi'));
  } catch {
    return [];
  }
};

// Resolve where Pi is, in the order a user expects: an explicit settings value, PATH, common
// global installs, the copy this plugin installed, then a pre-0.4 copy kept in plugin state.
export function findPi(settings = {}, {
  env = process.env,
  home = homedir(),
  usable = isExecutableFile,
  read = readdirSync,
} = {}) {
  const configured = typeof settings?.['pi.commandPath'] === 'string'
    ? settings['pi.commandPath'].trim()
    : '';
  if (configured && configured !== 'pi') return configured;

  const onPath = (env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'pi')).find(usable);
  if (onPath) return onPath;

  const own = managedPi(env, home);
  const legacy = legacyManagedPi(env);
  const candidates = [
    join(home, '.npm-global', 'bin', 'pi'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi',
    join(home, '.local', 'bin', 'pi'),
    join(home, '.bun', 'bin', 'pi'),
    join(home, '.volta', 'bin', 'pi'),
    join(home, 'Library', 'pnpm', 'pi'),
    join(home, '.local', 'share', 'pnpm', 'pi'),
    ...versionDirectories(join(home, '.nvm', 'versions', 'node'), ['bin'], read),
    ...versionDirectories(join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin'], read),
    // fnm's macOS data directory when XDG_DATA_HOME is not set.
    ...versionDirectories(join(home, 'Library', 'Application Support', 'fnm', 'node-versions'), ['installation', 'bin'], read),
    ...versionDirectories(join(home, '.asdf', 'installs', 'nodejs'), ['bin'], read),
    own,
    ...(legacy ? [legacy] : []),
  ];
  return candidates.find(usable) ?? 'pi';
}

// Resolve once when the Agent starts. `pi` and an empty value mean automatic discovery.
export function resolvePiLaunch(settings = {}, options = {}) {
  return findPi(settings, options);
}

export function assertPiVersion(version, launch) {
  if (!supportedVersion(version)) {
    throw new Error(
      `Pi ${version ?? '版本未知'}（${launchLabel(launch)}）不满足最低版本 ${MIN_PI_VERSION}。`
      + '请在插件设置中打开「Pi 跟随最新版」并保存，或使用原来的安装工具升级。',
    );
  }
  return version;
}

const runFile = promisify(execFile);
const versionKey = (launch, env, node) => JSON.stringify([
  normalizePiLaunch(launch).command,
  normalizePiLaunch(launch).prefixArgs,
  node,
  env?.PATH ?? '',
]);

// The version Pi reports, cached per launch. The fallback stands in when the runtime cannot
// run, so callers never wait or throw here.
const versionCache = new Map();
export async function piVersion(piCommand, {
  timeout = 5000,
  fallback = null,
  env = process.env,
  node = process.env.CODA_NODE || process.execPath,
} = {}) {
  const launch = normalizePiLaunch(piCommand);
  const key = versionKey(launch, env, node);
  if (!versionCache.has(key)) {
    try {
      const { stdout, stderr } = await runFile(launch.command, launchArgs(launch, ['--version']), {
        timeout,
        env: envForPiCommand(env, launch, node),
      });
      const version = parsePiVersion(`${stdout ?? ''}\n${stderr ?? ''}`);
      // A failed or unparseable probe must not permanently poison this Agent process. Only
      // cache successful observations so the next call can recover after PATH or permissions
      // are repaired.
      if (version) versionCache.set(key, version);
    } catch (error) {
      process.stderr.write(`[pi-agent] Pi --version failed: ${error.message}\n`);
    }
  }
  return versionCache.get(key) ?? (fallback ? await fallback() : null);
}

export function versionOf(piCommand, {
  env = process.env,
  node = process.env.CODA_NODE || process.execPath,
  run = spawnSync,
  timeout = 5_000,
} = {}) {
  const launch = normalizePiLaunch(piCommand);
  const result = run(launch.command, launchArgs(launch, ['--version']), {
    encoding: 'utf8',
    timeout,
    env: envForPiCommand(env, launch, node),
  });
  return result.status === 0
    ? parsePiVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    : null;
}
