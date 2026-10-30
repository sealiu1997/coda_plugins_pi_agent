import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkFakeLive, assertResumeEvidence } from '../scripts/check-fake-live.mjs';

test('official checker drives real plugin through instructions, prompt, steering, cancel, load and shutdown', async () => {
  assert.match(await checkFakeLive(), /结果：通过/);
});
test('fake live rejects Pi RPC failures rather than reporting skipped live as success', async () => {
  await assert.rejects(checkFakeLive({fail:'prompt'}),/退出|未执行/);
});
test('runtime rejects an obsolete Pi before any session starts', async () => {
  await assert.rejects(checkFakeLive({version:'1.0.0'}), /退出/);
});


test('loadSession:false in an isolated entry is rejected even when official checker exits zero', async () => {
  const entry = new URL('../agent/entry.mjs', import.meta.url), original = readFileSync(entry, 'utf8');
  try {
    await assert.rejects(checkFakeLive({ transformEntry: source => {
      assert.match(source, /loadSession: true/);
      return source.replace('loadSession: true', 'loadSession: false');
    } }), error => {
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.match(error.message, /必须明确验证新进程 session\/load/);
      assert.match(error.actual, /结果：通过/);
      assert.match(error.actual, /失败 0，跳过 1/);
      assert.match(error.actual, /没声明 loadSession/);
      return true;
    });
  } finally { assert.equal(readFileSync(entry, 'utf8'), original); }
});

const resumedOutput = '✓ 新进程 session/load 接上了会话 abc\n✓ 恢复后的一轮结束：stopReason end_turn';
const start = (pid, id = 'abc') => ({kind:'start',pid,args:['--mode','rpc','--session-id',id]});
const prompt = pid => ({kind:'rpc',pid,command:{type:'prompt'}});
test('resume contract requires both checker confirmations and ordered same-session RPC evidence', () => {
  const records = [start(1),prompt(1),start(2),prompt(2)];
  assert.doesNotThrow(()=>assertResumeEvidence(resumedOutput, records));
  assert.throws(()=>assertResumeEvidence('新进程 session/load', records), /恢复后的回合/);
  assert.throws(()=>assertResumeEvidence(resumedOutput, [start(1),prompt(1)]), /第二个 Pi RPC/);
  assert.throws(()=>assertResumeEvidence(resumedOutput, [start(1),start(2,'other'),prompt(2)]), /沿用/);
  assert.throws(()=>assertResumeEvidence(resumedOutput, [start(1),prompt(2),start(2)]), /再次执行 prompt/);
  assert.throws(()=>assertResumeEvidence(resumedOutput, [start(1),start(2),prompt(1)]), /再次执行 prompt/);
});
