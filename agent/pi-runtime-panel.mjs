import { inspectRuntime } from './pi-runtime.mjs';
import { MIN_PI_VERSION, supportedVersion } from './pi-command.mjs';

const runtime = inspectRuntime();
const current = runtime.version ?? '未安装';
const latest = runtime.latest ?? '检查失败';
const compatible = runtime.version ? supportedVersion(runtime.version) : false;
const oneLine = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const errorLine = value => {
  const lines = String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return oneLine(lines.find(line => /^(?:npm (?:ERR!|error)|Error:)/.test(line)) ?? lines.at(-1) ?? '未知错误', 450);
};
const items = [
  { type: 'stat', label: '当前版本', value: current },
  { type: 'stat', label: '最新版本', value: latest }
];
if (runtime.path) {
  items.push({ type: 'markdown', text: `**当前路径**\n\n\`${oneLine(runtime.path, 3900).replaceAll('`', '\\`')}\`` });
}

if (runtime.version && !compatible) {
  items.push({ type: 'error', text: `当前版本低于插件最低支持的 Pi ${MIN_PI_VERSION}` });
}
if (runtime.latestError) {
  items.push({ type: 'error', text: `检查最新版失败：${errorLine(runtime.latestError)}` });
}
if (runtime.canUpdate) {
  const upToDate = runtime.latest && !runtime.updateAvailable && runtime.version;
  items.push({
    type: 'button',
    label: !runtime.version ? '安装最新版' : runtime.latest ? `更新到 ${runtime.latest}` : '更新 Pi',
    action: 'update-latest',
    ...(upToDate ? { disabled: true } : {})
  });
} else if (runtime.path) {
  items.push({ type: 'error', text: '这是自定义安装，请用原安装工具升级，或把 pi.commandPath 改为 npm 安装的 Pi' });
}

const subtitle = runtime.version === runtime.latest && runtime.version
  ? '已是最新版'
  : runtime.updateAvailable ? `可更新到 ${runtime.latest}` : runtime.version ? '已安装' : '尚未安装 Pi';
process.stdout.write(JSON.stringify({ items: [{ type: 'card', title: 'Pi 运行时', subtitle, items }] }));
