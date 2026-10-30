import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { ProcessScope, minimalEnv } from './process-scope.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function checkFakeLive({ live = true, fail, version, checker = join(root, 'node_modules/@coda-console/plugin-check/bin/check.mjs') } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'pi-fake-live-')), scope = new ProcessScope().listen();
  try {
    const plugin = join(temp, 'plugin'), fake = join(temp, 'pi'), trace = join(temp, 'trace.jsonl');
    cpSync(join(root, 'agent'), join(plugin, 'agent'), { recursive: true });
    cpSync(join(root, 'icons'), join(plugin, 'icons'), { recursive: true });
    cpSync(join(root, 'package-lock.json'), join(plugin, 'package-lock.json'));
    writeFileSync(fake, `#!${process.execPath}\n${readFileSync(join(root, 'test/fixtures-fake-pi.mjs'), 'utf8')}`, { mode: 0o755 });
    const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
    manifest.contributes.configuration.properties['pi.commandPath'].default = fake;
    writeFileSync(join(plugin, 'package.json'), JSON.stringify(manifest));
    const result = await scope.run(process.execPath, [checker, plugin, ...(live ? ['--live'] : [])], {
      env: { ...minimalEnv(temp), FAKE_PI_TRACE: trace, ...(fail ? { FAKE_PI_FAIL: fail } : {}), ...(version ? { FAKE_PI_VERSION: version } : {}) }, cwd: temp, timeout: 60000, grace: 3000,
    });
    const records = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    if (live) {
      for (const type of ['get_state', 'get_available_models', 'get_commands', 'prompt', 'steer', 'abort', 'clear_queue']) assert.ok(records.some(r => r.command?.type === type), `${type} 未执行`);
      assert.ok(records.some(r => r.kind === 'settled' && r.aborted), '取消必须真正结束活动轮次');
      assert.match(result.stdout, /一轮进行中插话：injected/);
      assert.match(result.stdout, /stopReason cancelled/);
      assert.ok(records.some(r => r.kind === 'start' && r.args.includes('--print')), '必须运行标题子进程');
      assert.ok(records.some(r => r.kind === 'start' && r.args.includes('--append-system-prompt')), '必须传递系统提示词');
      assert.ok(records.some(r => r.kind === 'close' || r.kind === 'term'), '必须关闭 Pi');
    }
    return result.stdout;
  } finally { try { await scope.cleanup(); } finally { rmSync(temp, { recursive: true, force: true }); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(await checkFakeLive({ live: !process.argv.includes('--handshake'), ...(process.argv.includes('--checker') ? { checker: process.argv[process.argv.indexOf('--checker') + 1] } : {}) })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
