// The agent over ACP with a stand-in Pi: after a session's first turn that ends well, the
// plugin names the session with the model's own summary (agent/titles.mjs): a `pi --print`
// child of its own answers, the name is set with set_session_name, and Pi's
// session_info_changed hands it to Coda as a session_info_update.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "..");

// The stand-in Pi answers the startup commands; a prompt ends well. Called with --print (the
// plugin's summary child), it checks its explicit model extensions and answers a short title.
// FAKE_TITLE_BLOCK_MS makes that child hang so shutdown can be tested during naming.
// set_session_name is answered and confirmed with the session_info_changed a real Pi emits.
const FAKE_PI = `#!${process.execPath}
import { appendFileSync, openSync, writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
if (process.argv.includes("--print")) {
  const extensions = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--extension") extensions.push(process.argv[i + 1]);
  }
  if (!extensions.some(path => path?.includes("agent/providers.mjs")) ||
      !extensions.some(path => path?.includes("model-provider.mjs"))) {
    process.exit(2);
  }
  if (process.env.FAKE_TITLE_PID_FILE) {
    writeSync(openSync(process.env.FAKE_TITLE_PID_FILE, "w"), process.env.FAKE_TITLE_RUN_ID ?? String(process.pid));
  }
  if (process.env.FAKE_TITLE_SIGNALS_FILE) {
    process.on("SIGTERM", () => appendFileSync(process.env.FAKE_TITLE_SIGNALS_FILE, "TERM\\n"));
  }
  if (process.env.FAKE_TITLE_BLOCK_MS) await delay(Number(process.env.FAKE_TITLE_BLOCK_MS));
  process.stdout.write("插件打包与发布");
  if (!process.env.FAKE_TITLE_BLOCK_MS) process.exit(0);
}
const out = record => process.stdout.write(JSON.stringify(record) + "\\n");
const data = {
  get_state: { model: { provider: "p", id: "m" }, thinkingLevel: "off", sessionName: null },
  get_available_models: { models: [{ provider: "p", id: "m", name: "m" }] },
  get_available_thinking_levels: { levels: ["off"] },
  get_commands: { commands: [] },
};
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  if (command.type === "set_session_name") {
    out({ type: "response", id: command.id, command: command.type, success: true, data: {} });
    out({ type: "session_info_changed", name: command.name });
    return;
  }
  out({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "prompt" ? { disposition: "started" } : data[command.type] ?? {} });
  if (command.type !== "prompt") return;
  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "已经安排好了。" } });
  out({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop" }] });
  out({ type: "agent_settled", aborted: false });
});
`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = async path => {
  try { await readFile(path); return true; } catch { return false; }
};
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitForExit = async (pid, timeout = 500) => {
  const deadline = Date.now() + timeout;
  while (alive(pid) && Date.now() < deadline) await delay(10);
  return !alive(pid);
};

async function runAgent(dir, extraEnv = {}) {
  const fakePi = join(dir, "pi");
  await writeFile(fakePi, FAKE_PI);
  await chmod(fakePi, 0o755);
  const agent = spawn(process.execPath, [join(pluginPath, "agent", "entry.mjs")], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODA_PLUGIN_PATH: pluginPath, CODA_PLUGIN_STATE: join(dir, "state"),
      CODA_PLUGIN_SETTINGS: JSON.stringify({
        "pi.commandPath": fakePi,
        "pi.providers": { magpie: { url: "http://127.0.0.1:3425/v1" } },
        "pi.extraArgs": "--extension /models/model-provider.mjs",
      }),
      ...extraEnv,
    },
  });
  const messages = [];
  let pending = "";
  let stderr = "";
  const waiters = [];
  agent.stderr.on("data", chunk => { stderr += chunk; });
  agent.stdout.on("data", chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
    }
    for (const waiter of [...waiters]) if (waiter.found()) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
  });
  const until = found => found() ? Promise.resolve() : new Promise((resolve, reject) => {
    waiters.push({ found, resolve });
    setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(messages)}; stderr: ${stderr}`)), 10000).unref();
  });
  const request = (id, method, params) => agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return { agent, messages, until, request };
}

test("a session is named from its first finished turn, and the name reaches Coda", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-titles-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { agent, messages, until, request } = await runAgent(dir);
  t.after(() => agent.kill("SIGKILL"));
  request(1, "initialize", { protocolVersion: 1 });
  await until(() => messages.some(m => m.id === 1));
  request(2, "session/new", { cwd: dir, mcpServers: [] });
  await until(() => messages.some(m => m.id === 2));
  const { sessionId } = messages.find(m => m.id === 2).result;
  request(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "看一下怎么把这个插件打包发布" }] });
  await until(() => messages.some(m => m.id === 3));
  await until(() => messages.some(m => m.params?.update?.sessionUpdate === "session_info_update"));
  const titles = messages.filter(m => m.params?.update?.sessionUpdate === "session_info_update").map(m => m.params.update.title);
  assert.deepEqual(titles, ["插件打包与发布"]);
});

test("shutdown reaps a title child that is still running", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-title-shutdown-"));
  const titlePidFile = join(dir, "title.pid");
  const titleSignalsFile = join(dir, "title.signals");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { agent, messages, until, request } = await runAgent(dir, {
    FAKE_TITLE_BLOCK_MS: "60000",
    FAKE_TITLE_PID_FILE: titlePidFile,
    FAKE_TITLE_SIGNALS_FILE: titleSignalsFile,
  });
  t.after(async () => {
    agent.kill("SIGKILL");
    try {
      const pid = Number(await readFile(titlePidFile, "utf8"));
      if (pid) process.kill(pid, "SIGKILL");
    } catch {}
  });
  request(1, "initialize", { protocolVersion: 1 });
  await until(() => messages.some(m => m.id === 1));
  request(2, "session/new", { cwd: dir, mcpServers: [] });
  await until(() => messages.some(m => m.id === 2));
  const { sessionId } = messages.find(m => m.id === 2).result;
  request(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "看一下怎么把这个插件打包发布" }] });
  await until(() => messages.some(m => m.id === 3));
  while (!(await exists(titlePidFile))) await delay(10);
  const titlePid = Number(await readFile(titlePidFile, "utf8"));
  assert.equal(alive(titlePid), true);

  const started = Date.now();
  agent.kill("SIGTERM");
  const [code] = await once(agent, "close");
  assert.equal(code, 0);
  assert.ok(Date.now() - started >= 450, "shutdown gave the title child a TERM grace");
  assert.equal(await waitForExit(titlePid), true, "the title child was reaped");
  assert.equal(await readFile(titleSignalsFile, "utf8"), "TERM\n");
});
