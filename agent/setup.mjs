import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE, findPi, managedPi, legacyManagedPi, managedPrefix, parsePiVersion, supportedVersion, MIN_PI_VERSION, VERIFIED_PI_VERSION } from './pi-command.mjs';

import { prepareRuntime } from './pi-install.mjs';

// With Coda's Node first on the PATH: Pi's command, and npm's, are Node scripts.
const withNode = (env, node) => ({ ...env, PATH: [dirname(node), env.PATH].filter(Boolean).join(delimiter) });

// What a Pi says it is; null when it does not run.
export function versionOf(command, { env = process.env, node = process.execPath, run = spawnSync } = {}) {
  const result = run(command, ['--version'], { encoding: 'utf8', timeout: 20_000, env: withNode(env, node) });
  return result.status === 0 ? parsePiVersion(result.stdout) || '?' : null;
}

// 0 once Pi runs here; 1 with the reason as the last line, which Coda shows.
export function setup({ env = process.env, node = process.execPath, run = spawnSync, find = findPi, exists = existsSync,
  upgradeLatest = false, prepare = prepareRuntime, say = line => process.stdout.write(`${line}\n`), fail = line => process.stderr.write(`${line}\n`) } = {}) {
  const settings = JSON.parse(env.CODA_PLUGIN_SETTINGS || '{}');
  const found = find(settings, { env });
  const version = found === 'pi' ? null : versionOf(found, { env, node, run });
  const configured = settings['pi.commandPath'];
  const explicitlyConfigured = configured && configured !== 'pi';
  if (version && supportedVersion(version) && (!upgradeLatest || ![managedPi(env), legacyManagedPi(env)].includes(found) || explicitlyConfigured)) { say(`已有 Pi ${version}：${found}`); return 0; }
  const prefix = managedPrefix(env), own = managedPi(env);
  const managed = found === own || found === legacyManagedPi(env);
  // A path set in Coda is what findPi returns, so what it says differs only in what the user can do about it.
  if (version && (!managed || explicitlyConfigured)) {
    fail(`Pi ${version}（${found}）低于最低版本 ${MIN_PI_VERSION} 或版本无法识别；请自行 npm i -g ${PACKAGE}@${VERIFIED_PI_VERSION}，或改正 pi.commandPath。插件不会覆盖外部或显式配置的 Pi`);
    return 1;
  }
  if ((found !== 'pi' && !managed) || explicitlyConfigured) {
    fail(configured && configured !== 'pi'
      ? `设置里的 Pi 路径 ${configured} 运行不了：改正它，或改回 pi 由插件安装`
      : `找到的 Pi ${found} 运行不了：删除、修好它，或设置 pi.commandPath 指向可用的 Pi`);
    return 1;
  }
  const npm = join(dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!prefix) { fail(`这个后端没有插件状态目录，装不了 Pi：请自己安装 npm i -g ${PACKAGE}`); return 1; }
  if (!exists(npm)) { fail(`Coda 的 Node 没带 npm（${npm}），装不了 Pi：请自己安装 npm i -g ${PACKAGE}`); return 1; }
  const target = `${PACKAGE}@${upgradeLatest ? 'latest' : VERIFIED_PI_VERSION}`;
  say(`安装 ${target} 到 ${prefix}`);
  try { prepare(prefix, upgradeLatest); } catch (error) { fail(`准备 Pi 安装目录失败：${error.message}`); return 1; }
  const installEnv = { PATH: withNode(env, node).PATH, HOME: prefix, TMPDIR: env.TMPDIR || prefix,
    NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: join(prefix, 'empty-global.npmrc') };
  const installed = run(node, [npm, upgradeLatest ? 'install' : 'ci', '--cache', join(prefix, 'npm-cache'), '--no-fund', '--no-audit', '--no-update-notifier', '--ignore-scripts'],
    { cwd: prefix, stdio: 'inherit', timeout: 9 * 60_000, env: installEnv });
  if (installed.status !== 0) { fail(`安装 Pi 失败（npm ${installed.error?.message ?? `退出码 ${installed.status ?? installed.signal}`}），见上面的输出`); return 1; }
  const now = versionOf(own, { env, node, run });
  if (!now || !supportedVersion(now)) { fail(`装好了，但 ${own} 运行不了`); return 1; }
  say(`已安装 Pi ${now}：${own}`);
  return 0;
}

// Run as a command (Node names the module by its real path, so the path it was given is resolved the same way).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--upgrade-latest')) { console.error('用法：node agent/setup.mjs [--upgrade-latest]'); process.exitCode = 1; }
  else process.exitCode = setup({ upgradeLatest: args.includes('--upgrade-latest') });
}
