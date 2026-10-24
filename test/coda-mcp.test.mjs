import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codaMcp, { convertCodaMcpServers, literalConfigValue } from "../agent/coda-mcp.mjs";

test("converts stdio servers, including their env array and cwd", () => {
  const servers = convertCodaMcpServers([
    {
      name: "tools",
      command: "/usr/local/bin/tools",
      args: ["--verbose"],
      env: [{ name: "API_KEY", value: "secret" }, { name: "BAD", value: 1 }, "bad"],
      cwd: "/tmp/tools",
    },
  ]);
  assert.deepEqual(servers, {
    tools: {
      command: "/usr/local/bin/tools",
      args: ["--verbose"],
      env: { API_KEY: "secret" },
      cwd: "/tmp/tools",
    },
  });
});

test("converts HTTP headers and skips SSE and incomplete servers", () => {
  const messages = [];
  const log = message => messages.push(message);
  const servers = convertCodaMcpServers([
    { name: "docs", type: "http", url: "https://example.test/mcp", headers: [{ name: "Authorization", value: "Bearer token" }] },
    { name: "legacy", type: "sse", url: "https://example.test/sse" },
    { name: "broken-http", type: "http", headers: [] },
    { name: "missing", url: "https://example.test/mcp" },
  ], log);

  assert.deepEqual(servers, {
    docs: { url: "https://example.test/mcp", headers: { Authorization: "Bearer token" } },
  });
  assert.equal(messages.filter(message => message.includes("legacy")).length, 1);
  assert.equal(messages.filter(message => message.includes("broken-http")).length, 1);
  assert.equal(messages.filter(message => message.includes("missing")).length, 1);
});

test("skips invalid names and dash-underscore collisions, keeping the first server", () => {
  const messages = [];
  const log = message => messages.push(message);
  const servers = convertCodaMcpServers([
    { name: "first-server", command: "first" },
    { name: "first_server", command: "second" },
    { name: "bad name", command: "tools" },
    { name: "", command: "tools" },
    { name: "second-server", command: "second" },
  ], log);

  assert.deepEqual(Object.keys(servers), ["first-server", "second-server"]);
  assert.deepEqual(servers["first-server"], { command: "first", args: [], env: {} });
  assert.equal(messages.filter(message => message.includes("first_server")).length, 1);
  assert.equal(messages.filter(message => message.includes("bad name")).length, 1);
});

test("exposes Coda directly and leaves other servers at Pi's default", () => {
  const servers = convertCodaMcpServers([
    { name: "coda", command: "node", args: ["mcp-shim.mjs"] },
    { name: "other", command: "node", args: ["other.mjs"] },
  ]);

  assert.equal(servers.coda.exposure, "direct");
  assert.equal(servers.other.exposure, undefined);
});

test("the extension reads a 0600 file and continues after one registration fails", async t => {
  const dir = await mkdtemp(join(tmpdir(), "coda-mcp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "servers.json");
  await writeFile(file, JSON.stringify({
    coda: { command: "node", args: [], env: {}, exposure: "direct" },
    broken: { command: "node", args: [] },
  }));
  await chmod(file, 0o600);
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });

  const registered = [];
  process.env.PI_CODA_MCP_FILE = file;
  const pi = {
    registerMcpServer(name, config) {
      if (name === "broken") throw new Error("invalid config");
      registered.push([name, config]);
    },
  };
  await codaMcp(pi);

  assert.deepEqual(registered.map(([name]) => name), ["coda"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).coda.exposure, "direct");
});

test("writes env and header values in Pi's literal form, so Pi neither runs nor expands them", () => {
  assert.equal(literalConfigValue("plain"), "plain");
  assert.equal(literalConfigValue("!printf RAN"), "$!printf RAN");
  assert.equal(literalConfigValue("Bearer ${TOKEN}"), "Bearer $${TOKEN}");
  assert.equal(literalConfigValue("$HOME"), "$$HOME");
  assert.equal(literalConfigValue("!$X"), "$!$$X");
  assert.equal(literalConfigValue("x!y"), "x!y");
  const servers = convertCodaMcpServers([
    { name: "tools", command: "/bin/tools", env: [{ name: "KEY", value: "!rm -rf ~" }] },
    { name: "web", type: "http", url: "https://example.com/mcp", headers: [{ name: "Authorization", value: "Bearer $TOKEN" }] },
  ]);
  assert.equal(servers.tools.env.KEY, "$!rm -rf ~");
  assert.equal(servers.web.headers.Authorization, "Bearer $$TOKEN");
});
