import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { ProcessScope, minimalEnv } from './process-scope.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function assertResumeEvidence(output, records) {
  assert.match(output, /新进程\s+session\/load/, '官方 checker 必须明确验证新进程 session/load');
  assert.match(output, /恢复后的一轮结束/, '官方 checker 必须明确验证恢复后的回合');
  const rpcStarts = records.flatMap((record, index) => record.kind === 'start' && record.args[record.args.indexOf('--mode') + 1] === 'rpc' ? [{ record, index }] : []);
  assert.ok(rpcStarts.length >= 2, '恢复必须启动第二个 Pi RPC 进程');
  const [first, second] = rpcStarts;
  const sessionId = record => record.args[record.args.indexOf('--session-id') + 1];
  assert.ok(first.record.args.includes('--session-id') && sessionId(first.record), '首次 RPC 启动必须有 session-id');
  assert.ok(second.record.args.includes('--session-id') && sessionId(second.record), '恢复 RPC 启动必须有 session-id');
  assert.equal(sessionId(second.record), sessionId(first.record), '恢复必须沿用首次 RPC 的 session-id');
  assert.ok(Number.isInteger(second.record.pid), '恢复 trace 必须记录 Pi 进程身份');
  assert.ok(records.slice(second.index + 1).some(record => record.kind === 'rpc' && record.command?.type === 'prompt' && record.pid === second.record.pid), '第二次 RPC 启动后必须由该进程再次执行 prompt');
}

export async function checkFakeLive({ live = true, fail, version, transformEntry, checker = join(root, 'node_modules/@coda-console/plugin-check/bin/check.mjs') } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'pi-fake-live-')), scope = new ProcessScope().listen();
  try {
    const plugin = join(temp, 'plugin'), fake = join(temp, 'pi'), trace = join(temp, 'trace.jsonl');
    cpSync(join(root, 'agent'), join(plugin, 'agent'), { recursive: true });
    // Regression tests may alter only the isolated copy, never the repository entry.
    if (transformEntry) {
      const entry = join(plugin, 'agent/entry.mjs');
      writeFileSync(entry, transformEntry(readFileSync(entry, 'utf8')));
    }
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
      assertResumeEvidence(result.stdout, records);
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
