import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compareVersions, inspectRuntime } from './pi-runtime.mjs';
import { MIN_PI_VERSION, supportedVersion } from './pi-command.mjs';

const oneLine = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const errorLine = value => {
  const lines = String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return oneLine(lines.find(line => /^(?:npm (?:ERR!|error)|Error:)/.test(line)) ?? lines.at(-1) ?? '未知错误', 450);
};

export function buildRuntimePanel(runtime) {
  const current = runtime.version ?? '未安装';
  const latest = runtime.latest ?? '检查失败';
  const compatible = runtime.version ? supportedVersion(runtime.version) : false;
  const comparison = compareVersions(runtime.version, runtime.latest);
  const items = [
    { type: 'stat', label: '当前版本', value: current },
    { type: 'stat', label: '最新版本', value: latest }
  ];
  const newerLatest = runtime.latest && compareVersions(runtime.latest, MIN_PI_VERSION) > 0;
  items.push({
    type: 'markdown',
    text: newerLatest
      ? `插件稳定兼容基线是 Pi ${MIN_PI_VERSION}。npm latest ${runtime.latest} 尚未人工确认完整适配；自动扫描告警不影响现有插件安装。`
      : `插件稳定兼容基线是 Pi ${MIN_PI_VERSION}。`
  });
  if (runtime.path) {
    items.push({ type: 'markdown', text: `**当前路径**\n\n\`${oneLine(runtime.path, 3900).replaceAll('`', '\\`')}\`` });
  }

  if (runtime.version && !compatible) {
    const belowMinimum = compareVersions(runtime.version, MIN_PI_VERSION) < 0;
    items.push({
      type: 'error',
      text: belowMinimum
        ? `当前版本低于插件最低支持的 Pi ${MIN_PI_VERSION}`
        : `当前版本不是插件支持的正式稳定版（最低 Pi ${MIN_PI_VERSION}）`
    });
  }
  if (runtime.latestError) {
    items.push({ type: 'error', text: `检查最新版失败：${errorLine(runtime.latestError)}` });
  }
  if (runtime.canUpdate) {
    const upToDate = comparison !== null && comparison >= 0;
    items.push({
      type: 'button',
      label: !runtime.version ? '安装最新版' : runtime.latest ? `更新到 ${runtime.latest}` : '更新 Pi',
      action: 'update-latest',
      ...(upToDate ? { disabled: true } : {})
    });
  } else if (runtime.path) {
    items.push({ type: 'error', text: '这是自定义安装，请用原安装工具升级，或把 pi.commandPath 改为 npm 安装的 Pi' });
  }

  const subtitle = runtime.updateAvailable
    ? runtime.canUpdate
      ? `可更新到 ${runtime.latest}`
      : `需用原安装工具升级到 ${runtime.latest}`
    : comparison === 0 ? '已是最新版' : runtime.version ? '已安装' : '尚未安装 Pi';
  return { items: [{ type: 'card', title: 'Pi 运行时', subtitle, items }] };
}

if (process.argv[1] && existsSync(process.argv[1])
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(buildRuntimePanel(inspectRuntime())));
}
