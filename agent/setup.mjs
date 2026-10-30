import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  MIN_PI_VERSION,
  launchLabel,
  normalizePiLaunch,
  resolvePiLaunch,
  supportedVersion,
  versionOf,
} from './pi-command.mjs';

// 0 once the selected Pi runs here; 1 with the reason as the last line, which Coda shows.
// Coda installs the plugin's npm dependency before running setup, so the managed path has
// no network work to do. An explicit external pi.commandPath is only verified, never changed.
export function setup({
  env = process.env,
  node = env.CODA_NODE || process.execPath,
  run = spawnSync,
  resolve = resolvePiLaunch,
  say = line => process.stdout.write(`${line}\n`),
  fail = line => process.stderr.write(`${line}\n`),
} = {}) {
  let settings = {};
  try { settings = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}'); } catch {}

  const launch = normalizePiLaunch(resolve(settings, {
    pluginPath: env.CODA_PLUGIN_PATH || '.',
    node,
  }));
  const version = versionOf(launch, { env, run });
  if (!version) {
    fail(launch.kind === 'managed'
      ? `插件内置 Pi 无法运行（${launchLabel(launch)}）。请更新或重新安装 Pi 插件后重试准备运行环境。`
      : `设置里的 Pi 路径无法运行（${launchLabel(launch)}）。请修正 pi.commandPath，或改回 pi 使用插件内置运行时。`);
    return 1;
  }
  if (!supportedVersion(version)) {
    fail(`Pi ${version}（${launchLabel(launch)}）低于最低版本 ${MIN_PI_VERSION}。${
      launch.kind === 'managed'
        ? '请更新或重新安装 Pi 插件'
        : '请用原安装方式升级这个 Pi，或把 pi.commandPath 改回 pi'
    }。`);
    return 1;
  }
  say(`Pi ${version} 可用：${launchLabel(launch)}`);
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
