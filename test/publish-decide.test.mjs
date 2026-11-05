import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = await readFile(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");

// The `run` script of the "Decide whether this version is new" step, dedented.
function decideScript() {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l.trim().endsWith("name: Decide whether this version is new"));
  assert.notEqual(start, -1, "Decide step exists");
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === "run: |");
  const indent = lines[runAt + 1].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== "" && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

const NAME = "@coda-console/pi";
const VERSION = "1.5.0";
const WARN = 'npm warn Unknown user config "always-auth". This will stop working in the next major version of npm.';

// Runs the step in a temp dir with a fake `npm view` that prints `stdout` / `stderr` and exits `status`.
// No network; hard timeout so a regression cannot hang the suite.
async function runDecide({ stdout = "", stderr = "", status = 0 }) {
  const dir = await mkdtemp(join(tmpdir(), "publish-decide-"));
  try {
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: NAME, version: VERSION }));
    await writeFile(join(dir, "out.txt"), stdout);
    await writeFile(join(dir, "err.txt"), stderr);
    await writeFile(
      join(bin, "npm"),
      `#!/bin/sh
echo "$@" >> "${dir}/npm.log"
cat "${dir}/err.txt" >&2
cat "${dir}/out.txt"
exit ${status}
`,
      { mode: 0o755 },
    );
    const output = join(dir, "output.txt");
    const summary = join(dir, "summary.md");
    await writeFile(output, "");
    await writeFile(summary, "");
    const result = spawnSync("bash", ["-e", "-c", decideScript()], {
      cwd: dir,
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    return {
      ...result,
      outputs: (await readFile(output, "utf8")).split("\n").filter(Boolean),
      summary: await readFile(summary, "utf8"),
      calls: (await readFile(join(dir, "npm.log"), "utf8").catch(() => "")).split("\n").filter(Boolean),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("decide: already published, with an npm warn on stderr, skips publishing", async () => {
  const r = await runDecide({ stdout: `${VERSION}\n`, stderr: `${WARN}\n`, status: 0 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.outputs, [`spec=${NAME}@${VERSION}`, "publish=false"]);
  assert.match(r.summary, /已在 npm 上/);
  assert.deepEqual(r.calls, [`view ${NAME}@${VERSION} version`]);
});

test("decide: already published with a clean stderr also skips publishing", async () => {
  const r = await runDecide({ stdout: `${VERSION}\n` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.outputs.includes("publish=false"));
  assert.match(r.summary, /已在 npm 上/);
});

test("decide: a 404 behind an npm warn means not published yet", async () => {
  const r = await runDecide({
    stderr: `${WARN}\nnpm error code E404\nnpm error 404 No match found for version ${VERSION}\n`,
    status: 1,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.outputs, [`spec=${NAME}@${VERSION}`, "publish=true"]);
  assert.equal(r.summary, "");
});

test("decide: status 0 with empty stdout counts as not published", async () => {
  const r = await runDecide({ stderr: `${WARN}\n`, status: 0 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.outputs.includes("publish=true"));
});

for (const [label, stderr] of [
  ["ETIMEDOUT", "npm error code ETIMEDOUT\nnpm error network request failed\n"],
  ["503", "npm error code E503\nnpm error 503 Service Unavailable\n"],
]) {
  test(`decide: registry error (${label}) stops the run and prints it`, async () => {
    const r = await runDecide({ stderr: `${WARN}\n${stderr}`, status: 1 });
    assert.equal(r.status, 1);
    assert.ok(!r.outputs.includes("publish=true"));
    assert.ok(!r.outputs.includes("publish=false"));
    assert.ok((r.stdout + r.stderr).includes(stderr.split("\n")[0]), "original error is printed");
  });
}

test("decide: a different version in the answer (status 0) stops the run", async () => {
  const r = await runDecide({ stdout: "1.4.0\n" });
  assert.equal(r.status, 1);
  assert.ok(!r.outputs.includes("publish=true"));
  assert.ok(!r.outputs.includes("publish=false"));
  assert.match(r.stdout + r.stderr, /1\.4\.0/);
});
