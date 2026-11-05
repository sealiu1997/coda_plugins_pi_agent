import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  MIN_PI_VERSION,
  PI_SERIES,
  findPi,
  managedPrefix,
  supportedVersion,
  unverifiedNotice,
  versionOf,
} from './pi-command.mjs';
import {
  RollbackError,
  UPDATABLE,
  recoverIdleInstallation,
  recoverPendingInstallation,
  runtimeOwner,
  updatePi,
  updateTarget,
} from './pi-runtime.mjs';

export { versionOf };

const parseSettings = value => {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
};

// 0 once a supported Pi runs on this machine; 1 with the reason as the last line. Coda runs
// this after install, update and plugin-settings changes. Existing Pi installations are taken
// over first. A missing or too old Pi gets the newest patch of the series this plugin was
// verified against (npm; Homebrew, Bun and pnpm cannot pin one and get what their tool offers).
// A Pi newer than the verified series is never refused: it runs, with a note that it is
// unverified. Wanting a newer Pi than the series means waiting for the plugin to follow it.
export function setup({
  env = process.env,
  home = homedir(),
  node = env.CODA_NODE || process.execPath,
  run = spawnSync,
  find = findPi,
  realpath = realpathSync,
  update = updatePi,
  say = line => process.stdout.write(`${line}\n`),
  fail = line => process.stderr.write(`${line}\n`),
} = {}) {
  const settings = parseSettings(env.CODA_PLUGIN_SETTINGS);
  const configured = typeof settings['pi.commandPath'] === 'string'
    ? settings['pi.commandPath'].trim()
    : '';
  const explicitlyConfigured = configured && configured !== 'pi';
  try {
    recoverPendingInstallation({ env });
  } catch (error) {
    fail(`恢复上次未完成的 Pi 更新失败：${error.message}`);
    return 1;
  }
  let launch = find(settings, { env, home });
  let owner = runtimeOwner(launch === 'pi' ? null : launch, { env, home, realpath });
  const recoveryPrefix = owner.kind === 'npm'
    ? owner.prefix
    : owner.kind === 'none' || owner.kind === 'managed' ? managedPrefix(env, home) : null;
  if (recoveryPrefix) {
    try {
      if (recoverIdleInstallation(recoveryPrefix, { env })) {
        launch = find(settings, { env, home });
        owner = runtimeOwner(launch === 'pi' ? null : launch, { env, home, realpath });
      }
    } catch (error) {
      fail(`恢复上次未完成的 Pi 更新失败：${error.message}`);
      return 1;
    }
  }
  const version = launch === 'pi' ? null : versionOf(launch, { env, node, run });
  const installable = UPDATABLE.has(owner.kind);

  // The one place a ready Pi is reported, so a newer-than-verified Pi always gets its note.
  const ready = (line, readyVersion) => {
    say(line);
    const notice = unverifiedNotice(readyVersion);
    if (notice) say(notice);
    return 0;
  };

  const install = () => {
    // Only reached for a missing Pi or an automatically discovered, upgradable one: an explicit
    // pi.commandPath is never a missing Pi (findPi returns it as given), and `none` is upgradable.
    const target = updateTarget(owner, { env, home });
    // Only npm can pin a series; the other tools install what they offer.
    const pinned = owner.kind === 'none' || owner.kind === 'managed' || owner.kind === 'npm';
    say(`${owner.kind === 'none' ? '安装' : '更新'} Pi ${pinned ? `${PI_SERIES}.x` : 'latest'} 到 ${target}`);
    try {
      const installed = update({ env, home, node, run, find, realpath, series: pinned ? PI_SERIES : null });
      // Ready means the Pi the Agent will start, found by the same rules, is the one just checked.
      const started = find(settings, { env, home });
      const startedVersion = started === 'pi' ? null : versionOf(started, { env, node, run });
      if (!startedVersion || !supportedVersion(startedVersion) || startedVersion !== installed.version) {
        fail(`装好了 Pi ${installed.version ?? '版本未知'}（${installed.path ?? target}），但 Agent 会启动的 ${started} 是 ${startedVersion ?? '无法运行'}，最低需要 ${MIN_PI_VERSION}。请检查 pi.commandPath。`);
        return 1;
      }
      return ready(`${owner.kind === 'none' ? '已安装' : '已升级到兼容版本'} Pi ${startedVersion}：${started}`, startedVersion);
    } catch (error) {
      // Probe again: the snapshot taken before the update says nothing about what is installed now.
      const current = !(error instanceof RollbackError) && version
        ? versionOf(launch, { env, node, run })
        : null;
      if (current && supportedVersion(current)) {
        return ready(`更新 Pi 失败，继续使用已有的 Pi ${current}（${launch}）：${error.message}`, current);
      }
      fail(`${owner.kind === 'none' ? '安装' : '更新'} Pi 失败：${error.message}`);
      return 1;
    }
  };

  if (launch === 'pi') return install();

  if (!version) {
    if (!explicitlyConfigured && installable) return install();
    fail(explicitlyConfigured
      ? `设置里的 Pi 路径无法运行：${configured}。请改正 pi.commandPath，或改回 pi 使用自动发现/插件安装。`
      : `找到的 Pi ${launch} 无法运行。请修复或删除它，或在 pi.commandPath 中指定另一个 Pi。`);
    return 1;
  }

  if (!supportedVersion(version)) {
    if (installable && !explicitlyConfigured) return install();
    const below = `Pi ${version}（${launch}）不满足最低版本 ${MIN_PI_VERSION}（需要该版本或更新的稳定版）`;
    fail(explicitlyConfigured
      ? `${below}。这个 Pi 是你在 pi.commandPath 里指定的，插件不会改动它：请用原来的安装工具把它升到 ${PI_SERIES} 或更新，或清空 pi.commandPath（留为 pi）；清空后若它是 npm、Homebrew、Bun 或 pnpm 安装的，插件会原地升级它。`
      : `${below}，且它的来源无法自动升级。请用原来的工具把它升到 ${PI_SERIES} 或更新，或改用 npm、Homebrew、Bun 或 pnpm 安装。`);
    return 1;
  }

  return ready(`已有 Pi ${version} 可用：${launch}`, version);
}

// Run as a command (Node names the module by its real path, so the path it was given is resolved the same way).
if (process.argv[1] && existsSync(process.argv[1])
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.length > 2) {
    console.error('用法：node agent/setup.mjs');
    process.exitCode = 1;
  } else {
    process.exitCode = setup();
  }
}
