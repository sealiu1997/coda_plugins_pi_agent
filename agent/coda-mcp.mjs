// Convert Coda's ACP MCP server list, and register the result with Pi.
import { readFileSync } from 'node:fs';

const log = (...args) => process.stderr.write(`[pi-agent] ${args.join(' ')}\n`);
const validName = name => typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name);

// Pi reads MCP env and header values as config values: a leading `!` runs a shell command and `$VAR` / `${VAR}` expand.
// Coda's values are literal, so they are written in Pi's literal form: `$$` for `$`, and `$!` for a leading `!`.
export function literalConfigValue(value) {
  const escaped = value.replaceAll('$', '$$$$');
  return escaped.startsWith('!') ? `$${escaped}` : escaped;
}

function pairsToObject(items) {
  const result = {};
  if (!Array.isArray(items)) return result;
  for (const item of items) {
    if (typeof item?.name === 'string' && typeof item.value === 'string') {
      result[item.name] = literalConfigValue(item.value);
    }
  }
  return result;
}

export function convertCodaMcpServers(servers, writeLog = log) {
  const result = {};
  if (!Array.isArray(servers)) {
    if (servers != null) writeLog('mcpServers is not an array; skipping MCP setup');
    return result;
  }

  const seen = new Set();
  for (const server of servers) {
    const name = server?.name;
    if (!validName(name)) {
      writeLog(`Skipping MCP server with invalid name: ${JSON.stringify(name)}`);
      continue;
    }

    const collisionKey = name.replaceAll('-', '_');
    if (seen.has(collisionKey)) {
      writeLog(`Skipping MCP server ${name}: it collides with an earlier server name`);
      continue;
    }

    let config = null;
    if (server.type === 'http') {
      if (typeof server.url === 'string' && server.url) {
        config = {
          url: server.url,
          headers: pairsToObject(server.headers),
        };
      } else {
        writeLog(`Skipping MCP server ${name}: HTTP server has no URL`);
      }
    } else if (server.type === 'sse') {
      writeLog(`Skipping MCP server ${name}: Pi does not support SSE`);
    } else if (server.type == null || server.type === 'stdio') {
      if (typeof server.command === 'string' && server.command) {
        config = {
          command: server.command,
          args: Array.isArray(server.args) ? server.args : [],
          env: pairsToObject(server.env),
          ...(typeof server.cwd === 'string' ? { cwd: server.cwd } : {}),
        };
      } else {
        writeLog(`Skipping MCP server ${name}: stdio server has no command`);
      }
    } else {
      writeLog(`Skipping MCP server ${name}: unsupported type ${server.type}`);
    }

    if (!config) continue;
    if (name === 'coda') config.exposure = 'direct';
    seen.add(collisionKey);
    result[name] = config;
  }
  return result;
}

export default async function codaMcp(pi) {
  const file = process.env.PI_CODA_MCP_FILE;
  if (!file) {
    log('PI_CODA_MCP_FILE is not set; no Coda MCP servers were registered');
    return;
  }

  let servers;
  try {
    servers = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    log(`Could not read Coda MCP server file ${file}: ${e.message}`);
    return;
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    log(`Coda MCP server file ${file} does not contain an object`);
    return;
  }

  for (const [name, config] of Object.entries(servers)) {
    try {
      pi.registerMcpServer(name, config);
    } catch (e) {
      // Pi validates each registration. One invalid or duplicate server must not block the rest.
      log(`Could not register Coda MCP server ${name}: ${e.message}`);
    }
  }
}
