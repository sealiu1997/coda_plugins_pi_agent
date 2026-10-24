import { test } from "node:test";
import assert from "node:assert/strict";
import { usageUpdateFromStats } from "../agent/usage.mjs";

test("maps a full stats payload, including cost and extras", () => {
  const update = usageUpdateFromStats({
    tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 },
    cost: 0.45,
    contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30 },
  });
  assert.deepEqual(update, {
    sessionUpdate: "usage_update",
    used: 60000,
    size: 200000,
    cost: { amount: 0.45, currency: "USD" },
    _meta: { pi: { percent: 30, tokens: 105000 } },
  });
});

test("returns null when contextUsage is missing or unusable", () => {
  assert.equal(usageUpdateFromStats({}), null);
  assert.equal(usageUpdateFromStats({ contextUsage: {} }), null);
  // Right after compaction Pi reports null until a fresh assistant response.
  assert.equal(usageUpdateFromStats({ contextUsage: { tokens: null, contextWindow: 200000, percent: null } }), null);
  assert.equal(usageUpdateFromStats({ contextUsage: { tokens: 60000, contextWindow: null } }), null);
  assert.equal(usageUpdateFromStats({ contextUsage: { tokens: Number.NaN, contextWindow: 200000 } }), null);
});

test("cost is included only when it is a finite number", () => {
  const base = { contextUsage: { tokens: 1, contextWindow: 2, percent: 50 } };
  assert.deepEqual(usageUpdateFromStats({ ...base }).cost, undefined);
  assert.deepEqual(usageUpdateFromStats({ ...base, cost: "0.5" }).cost, undefined);
  assert.deepEqual(usageUpdateFromStats({ ...base, cost: Number.POSITIVE_INFINITY }).cost, undefined);
  assert.deepEqual(usageUpdateFromStats({ ...base, cost: 1.25 }).cost, { amount: 1.25, currency: "USD" });
});

test("meta extras are dropped when Pi offers none", () => {
  const update = usageUpdateFromStats({ contextUsage: { tokens: 1, contextWindow: 2 } });
  assert.deepEqual(update, { sessionUpdate: "usage_update", used: 1, size: 2 });
});
