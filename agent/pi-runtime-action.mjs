import { updateLatest } from './pi-runtime.mjs';

try {
  const result = updateLatest();
  process.stdout.write(result.installed ? `已安装 Pi ${result.version}：${result.path}\n` : `Pi 已更新到 ${result.version}：${result.path}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
