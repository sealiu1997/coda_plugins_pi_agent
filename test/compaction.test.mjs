import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCompactionEvent } from "../agent/compaction.mjs";

test("compaction_start opens a tracked in-progress update", () => {
  const session = {};
  const update = handleCompactionEvent(session, { type: "compaction_start", reason: "threshold" });
  assert.equal(update.status, "in_progress");
  assert.deepEqual(update._meta, { pi: { reason: "threshold" } });
  assert.match(update.compactionId, /^[0-9a-f-]{36}$/);
  assert.equal(session.compactionId, update.compactionId);
});

test("compaction retries patch the same compaction id", () => {
  const session = {};
  const start = handleCompactionEvent(session, { type: "compaction_start", reason: "overflow" });
  const retry = handleCompactionEvent(session, {
    type: "summarization_retry_scheduled", attempt: 2, maxAttempts: 3, delayMs: 2000, errorMessage: "terminated",
  });
  assert.equal(retry.compactionId, start.compactionId);
  assert.equal(retry.status, "in_progress");
  assert.deepEqual(retry._meta, { pi: { retry: { attempt: 2, maxAttempts: 3, errorMessage: "terminated" } } });
  const attempt = handleCompactionEvent(session, { type: "summarization_retry_attempt_start", source: "compaction", reason: "overflow" });
  assert.equal(attempt.compactionId, start.compactionId);
  assert.deepEqual(attempt._meta, { pi: { retry: { attempt: undefined, maxAttempts: undefined, errorMessage: undefined } } });
});

test("branch-summary retries are ignored", () => {
  const session = {};
  assert.equal(handleCompactionEvent(session, { type: "summarization_retry_attempt_start", source: "branchSummary" }), null);
});

test("successful compaction_end reports the summary and clears the id", () => {
  const session = { compactionId: "c1" };
  const update = handleCompactionEvent(session, {
    type: "compaction_end",
    reason: "threshold",
    willRetry: false,
    result: { summary: "Summary.", tokensBefore: 150000, estimatedTokensAfter: 32000 },
  });
  assert.equal(update.compactionId, "c1");
  assert.equal(update.status, "completed");
  assert.deepEqual(update.summary, [{ type: "text", text: "Summary." }]);
  assert.deepEqual(update._meta, {
    pi: { reason: "threshold", tokensBefore: 150000, estimatedTokensAfter: 32000, willRetry: false },
  });
  assert.equal(session.compactionId, null);
});

test("aborted compaction_end is cancelled and synthesizes an id without a start", () => {
  const session = {};
  const update = handleCompactionEvent(session, { type: "compaction_end", reason: "manual", aborted: true });
  assert.equal(update.status, "cancelled");
  assert.match(update.compactionId, /^[0-9a-f-]{36}$/);
  assert.equal(session.compactionId, null);
});

test("failed compaction_end carries the error message", () => {
  const session = { compactionId: "c2" };
  const update = handleCompactionEvent(session, { type: "compaction_end", reason: "threshold", errorMessage: "token cap" });
  assert.equal(update.status, "failed");
  assert.equal(update.error, "token cap");
  assert.equal(session.compactionId, null);
});

test("failed compaction_end without an error message falls back to a Chinese default", () => {
  const session = { compactionId: "c3" };
  const update = handleCompactionEvent(session, { type: "compaction_end", reason: "overflow" });
  assert.equal(update.status, "failed");
  assert.equal(update.error, "整理上下文失败");
});
