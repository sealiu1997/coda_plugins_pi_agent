import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PACKAGE, findPi, managedPi, supportedVersion, MIN_PI_VERSION } from './pi-command.mjs';
import { runtimeOwner, updateLatest, versionOf } from './pi-runtime.mjs';

export { versionOf };

// 0 once Pi runs here; 1 with the reason as the last line, which Coda shows.
export function setup({ env = process.env, home = homedir(), node = process.execPath, run = spawnSync, find = findPi,
  realpath = realpathSync, upgradeLatest = false, update = updateLatest,
  say = line => process.stdout.write(`${line}\n`), fail = line => process.stderr.write(`${line}\n`) } = {}) {
  const settings = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}');
  const found = find(settings, { env, home });
  const version = found === 'pi' ? null : versionOf(found, { env, node, run });
  const configured = settings['pi.commandPath'];
  const explicitlyConfigured = configured && configured !== 'pi';
  const own = managedPi(env, home);
  const managed = runtimeOwner(found, { env, home, realpath }).kind === 'managed';
  if (version && supportedVersion(version) && (!upgradeLatest || !managed || explicitlyConfigured)) {
    say(`已有 Pi ${version}：${found}`);
    return 0;
  }
  if (version && (!managed || explicitlyConfigured)) {
    fail(`Pi ${version}（${found}）低于最低版本 ${MIN_PI_VERSION} 或版本无法识别；请在 Pi 运行时的“更新到最新版”里升级，或执行 npm i -g ${PACKAGE}@latest。插件不会覆盖外部或显式配置的 Pi`);
    return 1;
  }
  if ((found !== 'pi' && !managed) || explicitlyConfigured) {
    fail(configured && configured !== 'pi'
      ? `设置里的 Pi 路径 ${configured} 运行不了：改正它，或改回 pi 由插件安装`
      : `找到的 Pi ${found} 运行不了：删除、修好它，或设置 pi.commandPath 指向可用的 Pi`);
    return 1;
  }
  say(`安装 Pi latest 到 ${own}`);
  try {
    const installed = update({ env, home, node, run, find });
    if (!installed.version || !supportedVersion(installed.version)) {
      fail(`装好了，但 ${installed.path ?? own} 运行不了`);
      return 1;
    }
    say(`已安装 Pi ${installed.version}：${installed.path ?? own}`);
  } catch (error) {
    fail(`安装 Pi 失败：${error.message}`);
    return 1;
  }
  return 0;
}

// Run as a command (Node names the module by its real path, so the path it was given is resolved the same way).
if (process.argv[1] && existsSync(process.argv[1])
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--upgrade-latest')) { console.error('用法：node agent/setup.mjs [--upgrade-latest]'); process.exitCode = 1; }
  else process.exitCode = setup({ upgradeLatest: args.includes('--upgrade-latest') });
}
