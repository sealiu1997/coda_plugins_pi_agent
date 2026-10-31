// The agent over ACP with a stand-in Pi: a turn reports usage when it settles, whether it ended well or failed late.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "..");

// Answers the commands the agent sends as a session starts; a prompt ends the way FAKE_PI_TURN says.
const FAKE_PI = `#!${process.execPath}
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { console.log("1.1.0"); process.exit(0); }
const out = record => process.stdout.write(JSON.stringify(record) + "\\n");
const data = {
  get_state: { model: { provider: "p", id: "m" }, thinkingLevel: "off" },
  get_available_models: { models: [{ provider: "p", id: "m", name: "m" }] },
  get_available_thinking_levels: { levels: ["off"] },
  get_commands: { commands: [] },
  get_session_stats: { cost: 0.25, tokens: { total: 900 }, contextUsage: { tokens: 400, contextWindow: 1000, percent: 40 } },
};
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  out({ type: "response", id: command.id, command: command.type, success: true, data: command.type === "prompt" ? { disposition: "started" } : data[command.type] ?? {} });
  if (command.type !== "prompt") return;
  const failed = process.env.FAKE_PI_TURN === "error";
  out({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "upstream failed" } : {}) }] });
  out({ type: "agent_settled", aborted: false });
});
`;

async function runTurn(turnEnd) {
  const dir = await mkdtemp(join(tmpdir(), "pi-turn-usage-"));
  const fakePi = join(dir, "pi");
  await writeFile(fakePi, FAKE_PI);
  await chmod(fakePi, 0o755);
  const agent = spawn(process.execPath, [join(pluginPath, "agent", "entry.mjs")], {
    cwd: dir,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, CODA_PLUGIN_PATH: pluginPath, CODA_PLUGIN_STATE: join(dir, "state"),
      CODA_PLUGIN_SETTINGS: JSON.stringify({ "pi.commandPath": fakePi }), FAKE_PI_TURN: turnEnd },
  });
  const messages = [];
  let pending = "";
  const waiters = [];
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
    setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(messages)}`)), 10000).unref();
  });
  const request = (id, method, params) => agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const answered = id => () => messages.some(m => m.id === id);
  const usage = () => messages.filter(m => m.params?.update?.sessionUpdate === "usage_update");
  try {
    request(1, "initialize", { protocolVersion: 1 });
    await until(answered(1));
    request(2, "session/new", { cwd: dir, mcpServers: [] });
    await until(answered(2));
    const { sessionId } = messages.find(m => m.id === 2).result;
    request(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    await until(answered(3));
    await until(() => usage().length > 0);
    return { prompt: messages.find(m => m.id === 3), usage: usage().map(m => m.params.update) };
  } finally {
    agent.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}

const expected = { sessionUpdate: "usage_update", used: 400, size: 1000, cost: { amount: 0.25, currency: "USD" } };

test("a turn that ends well reports usage after its response", async () => {
  const { prompt, usage } = await runTurn("stop");
  assert.equal(prompt.result.stopReason, "end_turn");
  assert.deepEqual(usage.map(({ _meta, ...u }) => u), [expected]);
});

test("a turn that fails after costing something still reports usage", async () => {
  const { prompt, usage } = await runTurn("error");
  assert.equal(prompt.error.message, "upstream failed");
  assert.deepEqual(usage.map(({ _meta, ...u }) => u), [expected]);
});
