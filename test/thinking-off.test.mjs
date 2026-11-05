// A model that can turn thinking off (GPT-6.1 Terra: levels off, low, ... max) through the real agent: off is
// listed and chosen like any other level, and reaches Pi as set_thinking_level, mid-conversation included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_PI_VERSION } from "../agent/pi-command.mjs";

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), "..");

const FAKE_PI = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) { console.log(${JSON.stringify(MIN_PI_VERSION)}); process.exit(0); }
const out = record => process.stdout.write(JSON.stringify(record) + "\\n");
let thinkingLevel = "medium";
const levels = ["off", "low", "medium", "high", "xhigh", "max"];
createInterface({ input: process.stdin }).on("line", line => {
  const command = JSON.parse(line);
  appendFileSync(process.env.FAKE_PI_LOG, line + "\\n");
  if (command.type === "set_thinking_level") thinkingLevel = command.level;
  const data = {
    get_state: { model: { provider: "openai", id: "gpt-6.1-terra" }, thinkingLevel },
    get_available_models: { models: [{ provider: "openai", id: "gpt-6.1-terra", name: "GPT-6.1 Terra" }] },
    get_available_thinking_levels: { levels },
    get_commands: { commands: [] },
  }[command.type] ?? {};
  out({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type === "set_thinking_level") out({ type: "thinking_level_changed", level: thinkingLevel });
});
`;

async function withAgent(body) {
  const dir = await mkdtemp(join(tmpdir(), "pi-thinking-off-"));
  const fakePi = join(dir, "pi");
  const log = join(dir, "commands.jsonl");
  await writeFile(fakePi, FAKE_PI);
  await chmod(fakePi, 0o755);
  const agent = spawn(process.execPath, [join(pluginPath, "agent", "entry.mjs")], {
    cwd: dir,
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, CODA_PLUGIN_PATH: pluginPath, CODA_PLUGIN_STATE: join(dir, "state"),
      CODA_PLUGIN_SETTINGS: JSON.stringify({ "pi.commandPath": fakePi }), FAKE_PI_LOG: log },
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
  let next = 0;
  const call = async (method, params) => {
    const id = ++next;
    agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await until(() => messages.some(m => m.id === id));
    return messages.find(m => m.id === id);
  };
  const sent = async () => (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  try {
    await call("initialize", { protocolVersion: 1 });
    await body({ call, sent, dir });
  } finally {
    agent.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}

const thinkingOf = options => options.find(o => o.id === "thinking");

test("thinking off is listed with the other levels and mapped to set_thinking_level", async () => {
  await withAgent(async ({ call, sent, dir }) => {
    const created = await call("session/new", { cwd: dir, mcpServers: [] });
    const { sessionId, configOptions } = created.result;
    const initial = thinkingOf(configOptions);
    assert.deepEqual(initial.options.map(o => o.value), ["default", "off", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(initial.currentValue, "medium");

    const off = await call("session/set_config_option", { sessionId, configId: "thinking", value: "off" });
    assert.equal(thinkingOf(off.result.configOptions).currentValue, "off");
    assert.deepEqual((await sent()).filter(c => c.type === "set_thinking_level").map(c => c.level), ["off"]);

    // Back to a real level mid-conversation, and to Pi's own default, which restores the level Pi started with.
    const high = await call("session/set_config_option", { sessionId, configId: "thinking", value: "high" });
    assert.equal(thinkingOf(high.result.configOptions).currentValue, "high");
    const reset = await call("session/set_config_option", { sessionId, configId: "thinking", value: "default" });
    assert.equal(thinkingOf(reset.result.configOptions).currentValue, "medium");
    assert.deepEqual((await sent()).filter(c => c.type === "set_thinking_level").map(c => c.level), ["off", "high", "medium"]);
  });
});
