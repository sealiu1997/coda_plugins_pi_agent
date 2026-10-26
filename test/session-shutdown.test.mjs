// The ACP agent reaps a Pi child that ignores SIGTERM: the parent stays alive through the
// grace period, sends SIGKILL, waits for close, and only then exits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { readlinkSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stopActiveChildren, stopChildren } from "../agent/shutdown.mjs";

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "..");

const FAKE_PI = `#!${process.execPath}
import { appendFileSync, openSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
writeSync(openSync(process.env.FAKE_PI_PID_FILE, "w"), String(process.pid));
process.on("SIGTERM", () => appendFileSync(process.env.FAKE_PI_SIGNALS_FILE, "TERM\\n"));
const out = record => process.stdout.write(JSON.stringify(record) + "\\n");
const data = {
  get_state: { model: { provider: "p", id: "m" }, thinkingLevel: "off", sessionName: null },
  get_available_models: { models: [{ provider: "p", id: "m", name: "m" }] },
  get_available_thinking_levels: { levels: ["off"] },
  get_commands: { commands: [] },
};
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  out({ type: "response", id: command.id, command: command.type, success: true, data: data[command.type] ?? {} });
});
`;

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitForExit(pid, timeout = 500) {
  const deadline = Date.now() + timeout;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return !alive(pid);
}

test("stopChildren sends TERM, waits its grace, then KILL", async () => {
  const signals = [];
  let exited = false;
  let resolveExit;
  const pi = {
    get exited() { return exited; },
    waitForExit() { return new Promise(resolve => { resolveExit = resolve; }); },
    kill(signal) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        exited = true;
        resolveExit();
      }
    },
  };
  const started = Date.now();
  await stopChildren([pi], { grace: 80 });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(Date.now() - started >= 70);
  assert.equal(exited, true);
});

test("stopChildren closes only handles that support stdin, then still reaps the rest", async () => {
  const events = [];
  const makeChild = name => {
    let exited = false;
    let resolveExit;
    const exit = new Promise(resolve => { resolveExit = resolve; });
    return {
      name,
      get exited() { return exited; },
      waitForExit() { return exit; },
      close() { events.push(`${name}:close`); },
      kill(signal) {
        events.push(`${name}:${signal}`);
        if (signal === "SIGKILL") {
          exited = true;
          resolveExit();
        }
      },
    };
  };
  const main = makeChild("main");
  const title = makeChild("title");
  delete title.close;
  main.close = () => events.push("main:close");
  await stopChildren([main, title], { grace: 20, closeFirst: true });
  assert.deepEqual(events.sort(), [
    "main:SIGKILL",
    "main:SIGTERM",
    "main:close",
    "title:SIGKILL",
    "title:SIGTERM",
  ]);
});

test("stopActiveChildren drains children registered after shutdown begins", async () => {
  const events = [];
  let late;
  let first = {
    exited: false,
    waitForExit: () => new Promise(resolve => { first.resolveExit = resolve; }),
    kill: signal => events.push(`first:${signal}`),
  };
  const draining = stopActiveChildren(() => {
    if (!late) {
      first.exited = false;
      late = {
        exited: false,
        waitForExit: () => Promise.resolve(),
        kill: signal => {
          events.push(`late:${signal}`);
          late.exited = true;
        },
      };
      return [first];
    }
    return [first, late];
  }, { grace: 20 });
  while (!first.resolveExit) await new Promise(resolve => setImmediate(resolve));
  first.exited = true;
  first.resolveExit();
  await draining;
  assert.deepEqual(events, ["first:SIGTERM", "late:SIGTERM"]);
});

test("shutdown waits through TERM grace and reaps a Pi child that ignores it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shutdown-"));
  const fakePi = join(dir, "pi");
  const pidFile = join(dir, "pi.pid");
  const signalsFile = join(dir, "signals");
  await writeFile(fakePi, FAKE_PI);
  await chmod(fakePi, 0o755);
  const agent = spawn(process.execPath, [join(pluginPath, "agent", "entry.mjs")], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      CODA_PLUGIN_PATH: pluginPath,
      CODA_PLUGIN_STATE: join(dir, "state"),
      CODA_PLUGIN_SETTINGS: JSON.stringify({ "pi.commandPath": fakePi }),
      FAKE_PI_PID_FILE: pidFile,
      FAKE_PI_SIGNALS_FILE: signalsFile,
    },
  });
  let output = "";
  agent.stdout.on("data", chunk => { output += chunk; });
  agent.stderr.on("data", () => {});
  t.after(async () => {
    agent.kill("SIGKILL");
    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      process.kill(pid, "SIGKILL");
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } }) + "\n");
  agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: dir, mcpServers: [] } }) + "\n");
  while (!output.includes('"id":2')) await once(agent.stdout, "data");
  const piPid = Number(await readFile(pidFile, "utf8"));
  assert.equal(alive(piPid), true);

  const started = Date.now();
  agent.kill("SIGTERM");
  const [code] = await once(agent, "close");
  assert.equal(code, 0);
  assert.ok(Date.now() - started >= 450, "shutdown waited for the child's TERM grace");
  const signals = await readFile(signalsFile, "utf8");
  if (!await waitForExit(piPid)) {
    let state = "unknown";
    try { state = readlinkSync(`/proc/${piPid}/exe`); } catch {
      try { state = execFileSync("ps", ["-o", "pid=,ppid=,stat=,command=", "-p", String(piPid)], { encoding: "utf8" }); } catch {}
    }
    assert.fail(`orphan ${piPid} survived; signals=${JSON.stringify(signals)} state=${state}`);
  }
  assert.equal(signals, "TERM\n");
  assert.equal(alive(piPid), false, "the orphan was sent SIGKILL and reaped");
});
