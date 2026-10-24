import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigOptions, isDefaultSentinel, modelValue, parseModelValue, DEFAULT_OPTION, PI_MODE } from "../agent/config-options.mjs";

const session = (overrides = {}) => ({
  models: [{ provider: "anthropic", id: "claude-x", name: "Claude X" }],
  currentModelValue: "anthropic/claude-x",
  thinkingLevels: ["off", "medium", "high"],
  currentThinkingLevel: "medium",
  defaultModelValue: "anthropic/claude-x",
  defaultThinkingLevel: "medium",
  ...overrides,
});

test("model value encodes a model and parses back", () => {
  assert.equal(modelValue({ provider: "anthropic", id: "claude-x" }), "anthropic/claude-x");
  assert.deepEqual(parseModelValue("anthropic/claude-x"), { provider: "anthropic", modelId: "claude-x" });
});

test("a model id may contain slashes", () => {
  assert.deepEqual(parseModelValue("openrouter/x/y"), { provider: "openrouter", modelId: "x/y" });
});

test("model and thinking options lead with the Pi default sentinel", () => {
  const opts = buildConfigOptions(session());
  const model = opts.find(o => o.id === "model");
  const thinking = opts.find(o => o.id === "thinking");
  assert.deepEqual(model.options[0], DEFAULT_OPTION);
  assert.deepEqual(thinking.options[0], DEFAULT_OPTION);
  assert.deepEqual(DEFAULT_OPTION._meta, { coda: { default: true } });
  assert.equal(model.options[1].value, "anthropic/claude-x");
});

test("currentValue reports the real state, not the sentinel", () => {
  const opts = buildConfigOptions(session({ currentThinkingLevel: null }));
  assert.equal(opts.find(o => o.id === "model").currentValue, "anthropic/claude-x");
  assert.equal(opts.find(o => o.id === "thinking").currentValue, "medium");
});

test("the sentinel option is recognized as the no-explicit-choice value", () => {
  assert.equal(isDefaultSentinel("default"), true);
  assert.equal(isDefaultSentinel("anthropic/claude-x"), false);
});

test("thinking select is skipped when the model has no reasoning", () => {
  const opts = buildConfigOptions(session({ thinkingLevels: ["off"] }));
  assert.deepEqual(opts.map(o => o.id), ["mode", "model"]);
});

test("one fixed work mode is always reported, so Coda keeps the session as a shortcut", () => {
  const mode = buildConfigOptions(session()).find(o => o.id === "mode");
  assert.equal(mode.category, "mode");
  assert.equal(mode.currentValue, PI_MODE);
  assert.deepEqual(mode.options.map(o => o.value), [PI_MODE]);
  assert.equal(buildConfigOptions(session({ models: [] }))[0].id, "mode");
});

test("the sentinel choice only appears when the baseline is known", () => {
  const opts = buildConfigOptions(session({ defaultModelValue: null, defaultThinkingLevel: null }));
  assert.deepEqual(opts.find(o => o.id === "model").options.map(o => o.value), ["anthropic/claude-x"]);
  assert.deepEqual(opts.find(o => o.id === "thinking").options.map(o => o.value), ["off", "medium", "high"]);
});

test("a current model outside the list is appended as its own choice", () => {
  const opts = buildConfigOptions(session({ currentModelValue: "gone/removed-model" }));
  const model = opts.find(o => o.id === "model");
  assert.equal(model.currentValue, "gone/removed-model");
  assert.deepEqual(model.options.find(o => o.value === "gone/removed-model"), { value: "gone/removed-model", name: "gone/removed-model" });
  assert.deepEqual(model.options[0], DEFAULT_OPTION);
});

test("a current thinking level outside the list is appended too", () => {
  const opts = buildConfigOptions(session({ currentThinkingLevel: "xhigh" }));
  const thinking = opts.find(o => o.id === "thinking");
  assert.equal(thinking.currentValue, "xhigh");
  assert.ok(thinking.options.some(o => o.value === "xhigh" && o.name === "xhigh"));
});

test("a model-only baseline still offers the sentinel for thinking when the level is known", () => {
  const opts = buildConfigOptions(session({ defaultThinkingLevel: null }));
  assert.ok(opts.find(o => o.id === "model").options[0]._meta.coda.default);
  assert.deepEqual(opts.find(o => o.id === "thinking").options.map(o => o.value), ["off", "medium", "high"]);
});

test("the thinking sentinel only shows on the baseline model", () => {
  const opts = buildConfigOptions(session({ currentModelValue: "openai/gpt-y" }));
  const thinking = opts.find(o => o.id === "thinking");
  assert.deepEqual(thinking.options.map(o => o.value), ["off", "medium", "high"]);
  const baseline = buildConfigOptions(session());
  assert.deepEqual(baseline.find(o => o.id === "thinking").options[0], DEFAULT_OPTION);
});
