import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfigOptions, isDefaultSentinel, modelValue, parseModelValue, piDefaults, DEFAULT_OPTION } from "../agent/config-options.mjs";

const session = (overrides = {}) => ({
  models: [{ provider: "anthropic", id: "claude-x", name: "Claude X" }],
  currentModelValue: "anthropic/claude-x",
  thinkingLevels: ["off", "medium", "high"],
  currentThinkingLevel: "medium",
  defaultModelValue: "anthropic/claude-x",
  defaultThinkingLevel: "medium",
  ...overrides,
});

test("piDefaults reads Pi's startup model and thinking level", () => {
  assert.deepEqual(
    piDefaults({ defaultProvider: "anthropic", defaultModel: "claude-x", defaultThinkingLevel: "high" }),
    { model: "anthropic/claude-x", thinkingLevel: "high" },
  );
});

test("piDefaults prefers the per-model startup thinking level", () => {
  const user = {
    defaultProvider: "anthropic",
    defaultModel: "claude-x",
    defaultThinkingLevel: "high",
    modelThinkingLevels: { "anthropic/claude-x": "low" },
  };
  assert.deepEqual(piDefaults(user), { model: "anthropic/claude-x", thinkingLevel: "low" });
});

test("project settings override the agent directory", () => {
  const user = { defaultProvider: "anthropic", defaultModel: "claude-x", defaultThinkingLevel: "high" };
  const project = { defaultProvider: "openai", defaultModel: "gpt-y" };
  assert.deepEqual(piDefaults(user, project), { model: "openai/gpt-y", thinkingLevel: "high" });
});

test("piDefaults gives nothing when Pi has no explicit defaults", () => {
  assert.deepEqual(piDefaults({}), { model: null, thinkingLevel: null });
  assert.deepEqual(piDefaults({ defaultModel: "claude-x" }), { model: null, thinkingLevel: null });
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
  assert.deepEqual(opts.map(o => o.id), ["model"]);
});

test("the sentinel choice only appears when the baseline is known", () => {
  const opts = buildConfigOptions(session({ defaultModelValue: null, defaultThinkingLevel: null }));
  assert.deepEqual(opts.find(o => o.id === "model").options.map(o => o.value), ["anthropic/claude-x"]);
  assert.deepEqual(opts.find(o => o.id === "thinking").options.map(o => o.value), ["off", "medium", "high"]);
});

test("currentValue falls back into the option list", () => {
  const opts = buildConfigOptions(session({ currentModelValue: "gone/removed-model" }));
  assert.equal(opts.find(o => o.id === "model").currentValue, "default");
});
