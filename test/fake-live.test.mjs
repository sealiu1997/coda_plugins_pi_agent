import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFakeLive } from '../scripts/check-fake-live.mjs';

test('official checker drives real plugin through instructions, prompt, steering, cancel, load and shutdown', async () => {
  assert.match(await checkFakeLive(), /结果：通过/);
});
test('fake live rejects Pi RPC failures rather than reporting skipped live as success', async () => {
  await assert.rejects(checkFakeLive({fail:'prompt'}),/退出|未执行/);
});
test('runtime rejects an obsolete Pi before any session starts', async () => {
  await assert.rejects(checkFakeLive({version:'1.0.0'}), /退出/);
});
