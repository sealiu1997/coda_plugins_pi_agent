import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  MIN_PI_VERSION,
  findPi,
  managedPi,
  managedPrefix,
  supportedVersion,
  versionOf,
} from './pi-command.mjs';
import {
  RollbackError,
  recoverIdleInstallation,
  recoverPendingInstallation,
  runtimeOwner,
  updateLatest,
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
// over first. A missing Pi is installed into ~/.local; opt-in latest mode updates npm installs.
export function setup({
  env = process.env,
  home = homedir(),
  node = env.CODA_NODE || process.execPath,
  run = spawnSync,
  find = findPi,
  realpath = realpathSync,
  update = updateLatest,
  say = line => process.stdout.write(`${line}\n`),
  fail = line => process.stderr.write(`${line}\n`),
} = {}) {
  const settings = parseSettings(env.CODA_PLUGIN_SETTINGS);
  const configured = typeof settings['pi.commandPath'] === 'string'
    ? settings['pi.commandPath'].trim()
    : '';
  const explicitlyConfigured = configured && configured !== 'pi';
  const followLatest = settings['pi.updateLatest'] === true;
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
  const installable = owner.kind === 'none' || owner.kind === 'managed' || owner.kind === 'npm';

  const install = ({ updateRequested }) => {
    if (explicitlyConfigured && !version) {
      fail(`设置里的 Pi 路径无法运行：${configured}。请改正 pi.commandPath，或改回 pi 使用自动发现/插件安装。`);
      return 1;
    }
    if (!installable) {
      fail(`Pi ${version ?? '版本未知'}（${launch}）来自无法自动升级的安装方式。请用原来的安装工具升级，或在 pi.commandPath 中改为 npm 安装的 Pi。`);
      return 1;
    }
    const target = owner.kind === 'npm' ? owner.prefix : managedPi(env, home);
    say(`${owner.kind === 'none' ? '安装' : '更新'} Pi latest 到 ${target}`);
    try {
      const installed = update({ env, home, node, run, find, realpath });
      if (!installed.version || !supportedVersion(installed.version)) {
        fail(`装好了，但 ${installed.path ?? target} 运行不了或低于最低版本 ${MIN_PI_VERSION}`);
        return 1;
      }
      if (installed.changed === false) {
        say(`Pi ${installed.version} 已是最新版本：${installed.path ?? target}`);
      } else {
        say(`${owner.kind === 'none' ? '已安装' : updateRequested ? '已更新到' : '已升级到兼容版本'} Pi ${installed.version}：${installed.path ?? target}`);
      }
      return 0;
    } catch (error) {
      // Probe again: the snapshot taken before the update says nothing about what is installed now.
      const current = !(error instanceof RollbackError) && version
        ? versionOf(launch, { env, node, run })
        : null;
      if (current && supportedVersion(current)) {
        say(`更新 Pi 失败，继续使用已有的 Pi ${current}（${launch}）：${error.message}`);
        return 0;
      }
      fail(`${owner.kind === 'none' ? '安装' : '更新'} Pi 失败：${error.message}`);
      return 1;
    }
  };

  if (launch === 'pi') return install({ updateRequested: false });

  if (!version) {
    if (!explicitlyConfigured && installable) return install({ updateRequested: false });
    fail(explicitlyConfigured
      ? `设置里的 Pi 路径无法运行：${configured}。请改正 pi.commandPath，或改回 pi 使用自动发现/插件安装。`
      : `找到的 Pi ${launch} 无法运行。请修复或删除它，或在 pi.commandPath 中指定另一个 Pi。`);
    return 1;
  }

  if (!supportedVersion(version)) {
    if (installable && (!explicitlyConfigured || followLatest)) {
      return install({ updateRequested: followLatest });
    }
    fail(`Pi ${version}（${launch}）低于最低版本 ${MIN_PI_VERSION}。请用原来的安装工具升级，或在插件设置中打开「Pi 跟随最新版」并保存。`);
    return 1;
  }

  if (followLatest) {
    if (!installable) {
      say(`已有 Pi ${version} 可用：${launch}。它来自无法自动升级的安装方式；继续使用现有版本，请用原来的安装工具更新。`);
      return 0;
    }
    return install({ updateRequested: true });
  }

  say(`已有 Pi ${version} 可用：${launch}`);
  return 0;
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
