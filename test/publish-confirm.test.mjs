import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");

// The `run` script of the "Confirm the release" step, dedented.
function confirmScript() {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l.trim() === "name: Confirm the release");
  assert.notEqual(start, -1, "Confirm the release step exists");
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
  const indent = lines[runAt + 1].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== "" && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

// Runs the step with a fake curl that answers 404 `misses` times, then returns the packument version.
async function runConfirm({ misses, served = "1.5.0" }) {
  const dir = await mkdtemp(join(tmpdir(), "publish-confirm-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "curl"),
      `#!/bin/sh
echo "$@" >> "${dir}/curl.log"
n=$(wc -l < "${dir}/curl.log")
if [ "$n" -le ${misses} ]; then echo "curl: (22) 404" >&2; exit 22; fi
echo '{"name":"@coda-console/pi","version":"${served}"}'
`,
      { mode: 0o755 },
    );
    const summary = join(dir, "summary.md");
    await writeFile(summary, "");
    const result = spawnSync("bash", ["-e", "-c", confirmScript()], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        SPEC: "@coda-console/pi@1.5.0",
        GITHUB_STEP_SUMMARY: summary,
        CONFIRM_ATTEMPTS: "3",
        CONFIRM_INTERVAL: "0",
      },
    });
    const log = await readFile(join(dir, "curl.log"), "utf8").catch(() => "");
    return { ...result, summary: await readFile(summary, "utf8"), calls: log.split("\n").filter(Boolean) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("confirm: version readable on the first try exits 0 and reports the release", async () => {
  const r = await runConfirm({ misses: 0 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0], /https:\/\/registry\.npmjs\.org\/@coda-console%2fpi\/1\.5\.0$/);
  assert.equal(r.summary, "已发布 @coda-console/pi@1.5.0。\n");
});

test("confirm: registry 404s first, then serves the version: exits 0", async () => {
  const r = await runConfirm({ misses: 2 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 3);
  assert.match(r.summary, /^已发布 @coda-console\/pi@1\.5\.0。/);
});

test("confirm: never readable only warns and still exits 0", async () => {
  const r = await runConfirm({ misses: 99 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 3);
  assert.match(r.stdout, /^::warning::@coda-console\/pi@1\.5\.0 已发布，但 registry 暂时还读不到/);
  assert.match(r.summary, /已发布，但 registry 暂未读到/);
});

test("confirm: a different version in the answer does not count as confirmed", async () => {
  const r = await runConfirm({ misses: 0, served: "1.4.0" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::warning::/);
  assert.doesNotMatch(r.summary, /^已发布 @coda/);
});

// A curl that hangs like a stalled TLS handshake or response unless it is given `--max-time N`;
// with it, it sleeps N seconds and exits 28 (curl's timeout code).
const HANGING_CURL = (dir) => `#!/bin/sh
echo "$@" >> "${dir}/curl.log"
max=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--max-time" ]; then max="$2"; fi
  shift
done
if [ -z "$max" ]; then exec sleep 300; fi
sleep "$max"
exit 28
`;

test("confirm: a curl that hangs is cut off by the per-request limit, then only warns and exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publish-confirm-hang-"));
  let child;
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "curl"), HANGING_CURL(dir), { mode: 0o755 });
    const summary = join(dir, "summary.md");
    await writeFile(summary, "");
    const started = Date.now();
    const result = await new Promise((resolve) => {
      // Own process group, so the hard timeout also reaps a curl that never returns.
      child = spawn("bash", ["-e", "-c", confirmScript()], {
        detached: true,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          SPEC: "@coda-console/pi@1.5.0",
          GITHUB_STEP_SUMMARY: summary,
          CONFIRM_ATTEMPTS: "2",
          CONFIRM_INTERVAL: "0",
          CONFIRM_CURL_MAX_TIME: "1",
          CONFIRM_CURL_CONNECT_TIMEOUT: "1",
        },
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      const timer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        resolve({ hung: true, stdout });
      }, 10_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout });
      });
    });
    assert.ok(!result.hung, "the step hung: curl has no per-request time limit");
    assert.ok(Date.now() - started < 10_000);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^::warning::/);
    assert.match(await readFile(summary, "utf8"), /已发布，但 registry 暂未读到/);
    const calls = (await readFile(join(dir, "curl.log"), "utf8")).split("\n").filter(Boolean);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call, /--connect-timeout 1\b/);
      assert.match(call, /--max-time 1\b/);
    }
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});
