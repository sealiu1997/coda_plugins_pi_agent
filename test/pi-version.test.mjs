import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piVersion } from "../agent/pi-command.mjs";

async function scriptPi(dir, body) {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const path = join(bin, "pi");
  await writeFile(path, "#!/bin/sh\n" + body, { mode: 0o755 });
  return path;
}

test("piVersion reads the binary's own version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const pi = await scriptPi(dir, "echo 1.1.0\n");
    assert.equal(await piVersion(pi), "1.1.0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion takes the bare version out of decorated output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const pi = await scriptPi(dir, "echo 'pi 2.3.1 (abc123)'\n");
    assert.equal(await piVersion(pi), "2.3.1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion falls back when the binary cannot run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const pi = await scriptPi(dir, "exit 1\n");
    assert.equal(await piVersion(pi, { fallback: () => "0.2.1" }), "0.2.1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion falls back when the binary is not executable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const path = join(dir, "pi");
    await writeFile(path, "#!/bin/sh\necho 1.0.0\n", { mode: 0o644 });
    assert.equal(await piVersion(path, { fallback: () => "0.2.1" }), "0.2.1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("piVersion caches per command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-version-"));
  try {
    const pi = await scriptPi(dir, "echo 3.0.0\n");
    assert.equal(await piVersion(pi), "3.0.0");
    await chmod(pi, 0o000);
    assert.equal(await piVersion(pi, { fallback: () => "stale" }), "3.0.0");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
