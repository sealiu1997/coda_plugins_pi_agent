import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionDefaults, writeSessionDefaults } from "../agent/session-defaults.mjs";

test("session defaults round-trip through the state directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-defaults-"));
  try {
    assert.equal(readSessionDefaults(dir, "s1"), null);
    writeSessionDefaults(dir, "s1", { model: "anthropic/claude-x", thinkingLevel: "medium" });
    assert.deepEqual(readSessionDefaults(dir, "s1"), { model: "anthropic/claude-x", thinkingLevel: "medium" });
    const raw = JSON.parse(await readFile(join(dir, "defaults", "s1.json"), "utf8"));
    assert.deepEqual(raw, { model: "anthropic/claude-x", thinkingLevel: "medium" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session defaults persist each field independently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-defaults-"));
  try {
    writeSessionDefaults(dir, "s1", { model: null, thinkingLevel: "high" });
    assert.deepEqual(readSessionDefaults(dir, "s1"), { model: null, thinkingLevel: "high" });
    writeSessionDefaults(dir, "s2", { model: "openai/gpt-y", thinkingLevel: null });
    assert.deepEqual(readSessionDefaults(dir, "s2"), { model: "openai/gpt-y", thinkingLevel: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt defaults file reads as nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-defaults-"));
  try {
    writeSessionDefaults(dir, "s1", { model: "anthropic/claude-x", thinkingLevel: "low" });
    await writeFile(join(dir, "defaults", "s1.json"), "not json");
    assert.equal(readSessionDefaults(dir, "s1"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a defaults file without usable values reads as nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-defaults-"));
  try {
    await mkdir(join(dir, "defaults"), { recursive: true });
    await writeFile(join(dir, "defaults", "s1.json"), JSON.stringify({ model: 3, thinkingLevel: [] }));
    assert.equal(readSessionDefaults(dir, "s1"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
