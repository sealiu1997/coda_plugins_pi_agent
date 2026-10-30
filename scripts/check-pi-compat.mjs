// Inspect shipped declarations without importing Pi or running user extensions.
import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve, delimiter, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { findPi, PACKAGE, VERIFIED_PI_VERSION, parsePiVersion } from '../agent/pi-command.mjs';
import { prepareRuntime } from '../agent/pi-install.mjs';
import { ProcessScope, minimalEnv } from './process-scope.mjs';

export const PROBE_COMMANDS = ['get_state', 'get_commands', 'get_available_models', 'get_available_thinking_levels', 'get_session_stats'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const clean = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// A deliberately small declaration reader. Unsupported syntax is reported as unknown.
export function splitTop(text, separator = ';') {
  let depth = 0, quote = '', start = 0; const parts = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if ('\'"`'.includes(c)) { quote = c; continue; }
    if ('{([<'.includes(c)) depth++;
    if ('})]>'.includes(c) && !(c === '>' && text[i - 1] === '=')) depth--;
    if (depth === 0 && c === separator) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim()); return parts.filter(Boolean);
}
function braceEnd(text, start) {
  let depth = 0, quote = '';
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = ''; continue; }
    if ('\'"`'.includes(c)) quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}
export function declarations(files) {
  const db = new Map();
  for (const [file, raw] of Object.entries(files)) {
    const text = clean(raw);
    for (const m of text.matchAll(/\b(interface|type)\s+(\w+)(?:<[^;{}]*?>)?\s*(?:extends\s+([^{}]+))?\s*([={])/g)) {
      let body;
      if (m[4] === '{') {
        const start = m.index + m[0].length - 1, end = braceEnd(text, start);
        body = text.slice(start, end + 1);
        if (m[3]) body += ` & ${m[3]}`;
      } else body = splitTop(text.slice(m.index + m[0].length))[0];
      // Canonical files are loaded before auxiliary declarations.
      if (!db.has(m[2])) db.set(m[2], { body, file });
    }
  }
  return db;
}
export function members(body) {
  if (!body?.startsWith('{')) return {};
  return Object.fromEntries(splitTop(body.slice(1, braceEnd(body, 0))).flatMap(part => {
    const m = part.match(/^(?:readonly\s+)?(\w+)(\?)?\s*:\s*([\s\S]+)$/);
    return m ? [[m[1], { type: m[3], optional: !!m[2] }]] : [];
  }));
}
function variants(type, db, seen = new Set()) {
  if (!type || seen.has(type)) return [];
  seen = new Set([...seen, type]);
  const union = splitTop(type, '|');
  if (union.length > 1) return union.flatMap(t => variants(t, db, seen));
  const intersection = splitTop(type, '&');
  if (intersection.length > 1) return intersection.flatMap(t => variants(t, db, seen));
  if (type.startsWith('{')) return [members(type)];
  const indexed = type.match(/^([\w]+(?:<[^>]+>)?)\[([\s\S]+)\]$/);
  if (indexed) {
    const keys = indexed[2].match(/^["']/) ? [indexed[2].slice(1, -1)] : Object.keys(Object.assign({}, ...variants(indexed[1], db, seen)));
    return keys.flatMap(key => fieldTypes(variants(indexed[1], db, seen), [key], db).flatMap(t => variants(t, db, seen)));
  }
  return db.has(type.replace(/<.*>$/, '')) ? variants(db.get(type.replace(/<.*>$/, '')).body, db, seen) : [];
}
function discriminants(type, key, db) {
  const result = {};
  for (const shape of variants(type, db)) {
    for (const m of shape[key]?.type.matchAll(/["']([^"']+)["']/g) ?? []) {
      (result[m[1]] ??= []).push(shape);
    }
  }
  return result;
}
function fieldTypes(shapes, path, db) {
  if (!path.length) return shapes;
  const [key, ...rest] = path;
  const fields = shapes.flatMap(s => s[key] ? [s[key].type] : []);
  if (!rest.length) return fields;
  return fields.flatMap(t => {
    t = t.replace(/^readonly\s+/, '');
    if (rest[0] === '[]') {
      const element = t.match(/^([\s\S]+)\[\]$/)?.[1] ?? t.match(/^(?:Array|ReadonlyArray)<([\s\S]+)>$/)?.[1];
      return element ? fieldTypes(variants(element, db), rest.slice(1), db) : [];
    }
    if (['any', 'unknown'].includes(t)) return ['unknown'];
    const indexed = t.match(/^([\w]+(?:<[^>]+>)?)\[["'](\w+)["']\]$/);
    if (indexed) return fieldTypes(variants(indexed[1], db), [indexed[2], ...rest], db);
    const nested = variants(t, db);
    return nested.length ? fieldTypes(nested, rest, db) : /^(?:null|undefined)$/.test(t) ? [] : ['unknown'];
  });
}
function scalarTypes(t, db, seen = new Set()) {
  if (seen.has(t)) return [t];
  seen.add(t);
  if (db.has(t)) return splitTop(db.get(t).body, '|').flatMap(x => scalarTypes(x, db, seen));
  return splitTop(t, '|');
}
const kind = t => /^(?:true|false)$/.test(t) ? 'boolean' : /\[\]$|^(?:Readonly)?Array</.test(t) ? 'array'
  : /^(?:string|number|boolean)\b/.exec(t)?.[0] ?? (/^["']/.test(t) ? 'string' : t.startsWith('{') ? 'object' : 'unknown');

export function locatePackage(command, visited = new Set()) {
  if (visited.has(command)) throw new Error(`Pi 包装路径循环：${command}`);
  visited.add(command);
  if (!command.includes('/')) command = (process.env.PATH ?? '').split(delimiter).map(p => join(p, command)).find(existsSync) ?? command;
  const executable = realpathSync(command);
  for (let dir = dirname(executable); dirname(dir) !== dir; dir = dirname(dir)) {
    const p = join(dir, 'package.json');
    if (existsSync(p) && json(p).name === PACKAGE) return dir;
  }
  // Follow a literal absolute exec target, never evaluate shell code.
  const target = read(executable).match(/^exec\s+["']?(\/[^\s"']+)["']?\s/m)?.[1];
  if (target) return locatePackage(target, visited);
  throw new Error(`无法从 ${command} 定位 ${PACKAGE}；可用 --pi 指向 npm 安装的实际入口`);
}
function installedDependency(packageDir, name) {
  for (let dir = packageDir; dirname(dir) !== dir; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules/@earendil-works', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return join(packageDir, 'node_modules/@earendil-works', name);
}
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}
export function inspectPackage(packageDir, help) {
  const files = {};
  const primary = ['dist/modes/rpc/rpc-types.d.ts', 'dist/core/agent-session.d.ts', 'dist/core/extensions/types.d.ts', 'dist/core/settings-manager.d.ts'];
  const candidates = [...primary.map(p => join(packageDir, p)),
    ...['pi-agent-core', 'pi-ai', 'pi-mcp'].flatMap(p => walk(join(installedDependency(packageDir, p), 'dist'))), ...walk(join(packageDir, 'dist'))];
  for (const file of candidates.filter(p => p.endsWith('.d.ts'))) if (existsSync(file)) files[relative(packageDir, file)] = read(file);
  const db = declarations(files);
  const rpc = discriminants('RpcCommand', 'type', db), responses = discriminants('RpcResponse', 'command', db);
  // AgentSessionEvent wraps core events in Exclude/WithParentToolCallId; unwrap explicitly.
  const session = db.get('AgentSessionEvent');
  const eventType = session?.body.replace(/WithParentToolCallId<Exclude<AgentEvent,\s*\{[\s\S]*?\}>>/, 'AgentEvent');
  const events = discriminants(eventType, 'type', db);
  const ui = discriminants('RpcExtensionUIRequest', 'method', db);
  const extension = db.get('ExtensionAPI');
  const extensionMembers = extension ? splitTop(extension.body.slice(1, braceEnd(extension.body, 0))) : [];
  const extensionMethods = extensionMembers.map(p => p.match(/^(\w+)\??(?:<[^\n]*?>)?\s*\(/)?.[1]).filter(Boolean);
  const settingKeys = (type, prefix = '', depth = 0) => depth > 6 ? [] : variants(type, db).flatMap(shape => Object.entries(shape).flatMap(([key, field]) => {
    const name = prefix + key;
    return [name, ...settingKeys(field.type, name + '.', depth + 1)];
  }));
  const settings = settingKeys('Settings');
  const cli = [...help.matchAll(/^[ \t]{2}(--[\w-]+)(?:,\s*(-[\w-]+))?/gm)].flatMap(m => [m[1], ...(m[2] ? [m[2]] : [])]);
  const inventory = { commands: Object.keys(rpc), events: Object.keys(events), cli, extensionApi: extensionMethods, settings, uiMethods: Object.keys(ui) };
  const evidence = { commands: 'dist/modes/rpc/rpc-types.d.ts#RpcCommand', events: 'dist/core/agent-session.d.ts#AgentSessionEvent + pi-agent-core#AgentEvent',
    cli: 'pi --help#Options', extensionApi: 'dist/core/extensions/types.d.ts#ExtensionAPI', settings: 'dist/core/settings-manager.d.ts#Settings', uiMethods: 'dist/modes/rpc/rpc-types.d.ts#RpcExtensionUIRequest' };
  const unknown = [];
  for (const category of Object.keys(inventory)) {
    inventory[category] = [...new Set(inventory[category])].sort();
    if (inventory[category].length) continue;
    const docs = category === 'cli' ? ['docs/cli.md'] : category === 'settings' ? ['docs/settings.md'] : category === 'extensionApi' ? ['docs/extensions.md'] : ['docs/rpc.md', 'docs/rpc-commands.md'];
    const docText = docs.filter(p => existsSync(join(packageDir, p))).map(p => read(join(packageDir, p))).join('\n');
    const regex = category === 'commands' ? /"type"\s*:\s*"([\w_]+)"/g : category === 'cli' ? /--[\w-]+/g : /`([\w]+)`/g;
    inventory[category] = [...new Set([...docText.matchAll(regex)].map(m => m[1] ?? m[0]))].sort();
    evidence[category] = `${docs.join(', ')}（文本回退，低置信度）`;
    unknown.push(`${category} 缺少可识别的机读声明，文档结果仅供参考`);
  }
  const signatures = {
    commands: Object.fromEntries(Object.entries(rpc).map(([k, v]) => [k, JSON.stringify(v)])),
    responses: Object.fromEntries(Object.entries(responses).map(([k, v]) => [k, JSON.stringify(v)])),
    events: Object.fromEntries(Object.entries(events).map(([k, v]) => [k, JSON.stringify(v)])),
    extensionApi: Object.fromEntries(extensionMethods.map(name => [name, splitTop(extension.body.slice(1, braceEnd(extension.body, 0))).filter(p => new RegExp('^' + name + '[<(]').test(p)).map(p => p.replace(/\s+/g, ' ')).join('; ')])),
    cli: Object.fromEntries([...help.matchAll(/^[ \t]{2}(--[\w-]+)([^\n]*?)(?:[ \t]{2,})([^\n]*)$/gm)].map(m => [m[1], m[2].trim()])),
    types: Object.fromEntries([...db].filter(([name]) => /^(?:RpcSessionState|SessionStats|ContextUsage|Model|BaseModel|ModelCost.*|CompactionResult|Provider.*Config.*|Settings|ThinkingLevel|PromptDisposition|McpServerConfig|McpExposure)$/.test(name)).map(([name, d]) => [name, d.body.replace(/\s+/g, ' ')])),
  };
  for (const match of help.matchAll(/^[ \t]{2}(--[\w-]+),\s*(-[\w-]+)([^\n]*?)(?:[ \t]{2,})/gm)) {
    signatures.cli[match[2]] = match[3].trim();
  }
  return { db, rpc, responses, events, ui, inventory, evidence, unknown, signatures };
}

export function compare(surface, current, baseline) {
  const incompatible = [], review = [], passed = [];
  const item = (message, evidence) => ({ message, evidence });
  for (const [category, deps] of Object.entries(surface.dependencies)) {
    for (const dep of deps) {
      const evidence = `${dep.sources.join(', ')} → ${current.evidence[category]}#${dep.name}`;
      if (!current.inventory[category]?.includes(dep.normalizedTo ?? dep.name)) {
        (current.unknown.some(s => s.startsWith(category + ' ')) ? review : incompatible).push(item(`缺少 ${category} ${dep.name}`, evidence));
      } else passed.push(item(`${category} ${dep.name}`, evidence));
    }
  }
  for (const dep of surface.dependencies.extensionApi) {
    if (dep.signature && !current.signatures.extensionApi[dep.name]?.replace(/\s/g, '').includes(dep.signature.replace(/\s/g, ''))) incompatible.push(item(`扩展签名不兼容 ${dep.name}`, `${dep.sources.join(', ')} → ${current.evidence.extensionApi}#${dep.name}: ${current.signatures.extensionApi[dep.name]}`));
  }
  for (const dep of surface.dependencies.cli) {
    const signature = current.signatures.cli[dep.normalizedTo ?? dep.name];
    if (signature === undefined) review.push(item(`无法解析 CLI 签名 ${dep.name}`, `${dep.sources.join(', ')} → pi --help`));
    else if (/[<[]/.test(signature) !== !!dep.takesValue) incompatible.push(item(`CLI 参数形状变化 ${dep.name}`, `pi --help: ${dep.name} ${signature}`));
  }
  for (const dep of surface.dependencies.commands) {
    const allowed = new Set(['id', 'type', ...surface.contracts.filter(c => c.scope === 'command' && c.symbol === dep.name).flatMap(c => Object.keys(c.fields))]);
    const conditional = surface.contracts.find(c => c.scope === 'command' && c.symbol === dep.name)?.conditional ?? [];
    for (const shape of current.rpc[dep.name] ?? []) for (const [key, value] of Object.entries(shape)) if (!value.optional && (!allowed.has(key) || conditional.includes(key))) incompatible.push(item(`RPC ${dep.name} 新增必填参数 ${key}`, `${dep.sources.join(', ')} → ${current.evidence.commands}`));
  }
  for (const contract of surface.contracts) {
    const shapes = contract.scope === 'command' ? current.rpc[contract.symbol] : contract.scope === 'response' ? current.responses[contract.symbol]
      : contract.scope === 'event' ? current.events[contract.symbol] : contract.scope === 'ui' ? current.ui[contract.symbol] : variants(contract.symbol, current.db);
    if (!shapes?.length) { review.push(item(`无法解析形状 ${contract.symbol}`, contract.sources.join(', '))); continue; }
    for (const [path, expected] of Object.entries(contract.fields)) {
      const types = fieldTypes(shapes, path.split('.'), current.db).flatMap(t => scalarTypes(t, current.db));
      const evidence = `${contract.sources.join(', ')} → ${current.db.get(contract.symbol)?.file ?? current.evidence[contract.scope === 'event' ? 'events' : 'commands']}#${contract.symbol}.${path} (${types.join(' | ') || '缺失'})`;
      if (!types.length) incompatible.push(item(`字段缺失 ${contract.symbol}.${path}`, evidence));
      else if (types.includes('unknown')) review.push(item(`无法解析字段 ${contract.symbol}.${path}`, evidence));
      else if (expected !== 'any' && !types.some(t => kind(t) === expected)) {
        (types.every(t => kind(t) === 'unknown') ? review : incompatible).push(item(`字段类型需检查 ${contract.symbol}.${path}，预期 ${expected}`, evidence));
      } else passed.push(item(`字段 ${contract.symbol}.${path}`, evidence));
    }
  }
  for (const contract of surface.contracts.filter(c => c.inputObject)) {
    const allowed = new Set(Object.keys(contract.fields).map(p => p.split('.')[0]));
    for (const shape of variants(contract.symbol, current.db)) for (const [key, field] of Object.entries(shape)) if (!field.optional && !allowed.has(key)) incompatible.push(item(`扩展配置 ${contract.symbol} 新增必填字段 ${key}`, `${contract.sources.join(', ')} → ${current.db.get(contract.symbol)?.file}`));
  }
  for (const requirement of surface.values ?? []) {
    const declaration = current.db.get(requirement.symbol);
    const values = scalarTypes(requirement.symbol, current.db).join(' ').match(/["']([^"']+)["']/g)?.map(s => s.slice(1, -1)) ?? [];
    for (const value of requirement.values) if (!values.includes(value)) (declaration ? incompatible : review).push(item(`枚举缺失 ${requirement.symbol}.${value}`, `${requirement.sources.join(', ')} → ${declaration?.file ?? '无法定位声明'}`));
  }
  if (!baseline || baseline.reviewed !== true) review.push(item('尚无人确认基线；核对报告后运行 --accept', 'compat/pi-snapshot.json'));
  if (baseline && (baseline.schemaVersion !== 1 || Object.keys(current.inventory).some(key => !Array.isArray(baseline.inventory?.[key])) || Object.keys(current.signatures).some(key => !baseline.signatures?.[key] || typeof baseline.signatures[key] !== 'object' || Array.isArray(baseline.signatures[key])))) review.push(item('基线格式缺失或未知，需重新确认', 'compat/pi-snapshot.json'));
  if (baseline && baseline.version !== current.version) review.push(item(`Pi 版本漂移：${baseline.version} → ${current.version}`, 'pi --version / compat/pi-snapshot.json'));
  for (const [category, values] of Object.entries(current.inventory)) {
    if (!baseline) continue;
    for (const value of values) if (!(baseline.inventory?.[category] ?? []).includes(value)) review.push(item(`新增 ${category} ${value}`, current.evidence[category]));
  }
  if (baseline?.signatures) for (const [category, values] of Object.entries(current.signatures)) {
    for (const [symbol, signature] of Object.entries(values)) if (baseline.signatures[category]?.[symbol] && baseline.signatures[category][symbol] !== signature) review.push(item(`声明变化 ${category}.${symbol}`, category === 'types' ? current.db.get(symbol)?.file : current.evidence[category] ?? 'dist/modes/rpc/rpc-types.d.ts#RpcResponse'));
  }
  if (baseline?.signatures) for (const [category, values] of Object.entries(baseline.signatures)) {
    for (const symbol of Object.keys(values)) if (!(symbol in (current.signatures[category] ?? {}))) review.push(item(`声明消失或无法解析 ${category}.${symbol}`, '随包声明 / CLI 帮助'));
  }
  for (const message of current.unknown) review.push(item(message, '随包声明 / 文档'));
  return { incompatible, review, passed };
}

// Only a fixed allowlist of getters is sent. No prompt, auth, extensions or model calls.
export async function probe(command, directory, { spawnFn = spawn, timeout = 10000, env = process.env, scope = new ProcessScope() } = {}) {
  mkdirSync(directory, { recursive: true });
  const safeEnv = { PATH: `${dirname(process.execPath)}:${env.PATH ?? ''}`, HOME: directory, TMPDIR: directory,
    PI_CODING_AGENT_DIR: directory, PI_CODING_AGENT_SESSION_DIR: join(directory, 'sessions'), PI_OFFLINE: '1', PI_TELEMETRY: '0' };
  const child = spawnFn(command, ['--mode', 'rpc', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools'],
    { cwd: directory, env: safeEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const tracked = scope.track(child);
  let closed = false, failure, stderr = ''; const pending = new Map();
  child.once('close', () => { closed = true; for (const p of pending.values()) p.reject(new Error(`Pi 提前退出：${stderr}`)); });
  child.on('error', error => { failure = error; for (const p of pending.values()) p.reject(error); });
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let record;
    try { record = JSON.parse(line); } catch { failure = new Error('Pi 输出不是 JSON'); }
    if (!failure && (!record || typeof record !== 'object' || Array.isArray(record))) failure = new Error('Pi 输出不是 RPC 对象');
    if (failure) { for (const p of pending.values()) p.reject(failure); return; }
    if (record.type === 'response') pending.get(record.id)?.resolve(record);
  });
  const onSignal = () => { failure = new Error('检查被信号中断'); for (const p of pending.values()) p.reject(failure); };
  scope.controller.signal.addEventListener('abort', onSignal);
  const results = {};
  try {
    for (const name of PROBE_COMMANDS) {
      if (failure) throw failure;
      if (closed) throw new Error(`Pi 提前退出：${stderr}`);
      let timer;
      try {
        results[name] = await new Promise((resolve, reject) => {
          pending.set(name, { resolve, reject });
          timer = setTimeout(() => reject(new Error(`${name} 超时`)), timeout);
          child.stdin.write(`${JSON.stringify({ id: name, type: name })}\n`);
        });
      } finally { clearTimeout(timer); pending.delete(name); }
    }
    return results;
  } finally {
    lines.close();
    try { await scope.stop(tracked); } finally { scope.controller.signal.removeEventListener('abort', onSignal); }
  }
}
export function checkProbe(results, surface) {
  const failures = [], passed = [];
  for (const [name, response] of Object.entries(results)) {
    const evidence = `隔离 RPC ${name} / agent/pi-rpc.mjs`;
    if (response.success !== true || response.command !== name || response.type !== 'response') { failures.push({ message: `${name} 响应信封不兼容`, evidence }); continue; }
    for (const contract of surface.contracts.filter(c => c.scope === 'response' && c.symbol === name)) {
      for (const [path, expected] of Object.entries(contract.fields)) {
        const parts = path.split('.');
        let values = [response];
        for (const part of parts) values = part === '[]' ? values.flatMap(v => Array.isArray(v) ? v : []) : values.map(v => v?.[part]);
        // Optional/empty-session fields cannot be demonstrated by this probe.
        if (contract.optional?.includes(path) && values.every(v => v == null)) continue;
        if (!values.length) continue;
        if (values.some(v => v === undefined || (expected !== 'any' && (expected === 'array' ? !Array.isArray(v) : typeof v !== expected)))) failures.push({ message: `实测字段不兼容 ${name}.${path}`, evidence });
      }
    }
    passed.push({ message: `只读探测 ${name}`, evidence });
  }
  return { failures, passed };
}
export function changelogBetween(text, baseline, version) {
  if (baseline === version) return '';
  const sections = text.split(/(?=^##\s)/m), chosen = []; let active = false;
  for (const section of sections) {
    const v = section.match(/^##\s+\[?v?(\d+\.\d+\.\d+[^\s\]]*)/m)?.[1];
    if (v === version) active = true;
    if (v === baseline) break;
    if (active) chosen.push(section.trim());
  }
  return chosen.join('\n\n');
}
export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--json', '--accept', '--help'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--pi', '--install'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[++i];
    else throw new Error(`未知或缺少值的参数：${arg}`);
  }
  if (options.pi && options.install) throw new Error('--pi 与 --install 不能同时使用');
  if (options.install && !/^(?:latest|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(options.install)) throw new Error('--install 只接受 latest 或精确 npm 版本');
  return options;
}
export async function main(args = process.argv.slice(2), { run, remove = rmSync, snapshotPath = join(root, 'compat/pi-snapshot.json'), surfacePath = join(root, 'compat/pi-surface.json'), probeFn = probe } = {}) {
  let options, temp;
  const scope = new ProcessScope().listen();
  run ??= scope.run.bind(scope);
  let baselineState = { present: false, reviewed: false, schemaVersion: null, version: null };
  try {
    options = parseArgs(args);
    if (options.help) { console.log('用法：node scripts/check-pi-compat.mjs [--pi 路径 | --install 版本或latest] [--json] [--accept]\n--accept 表示你已人工确认当前 Pi，更新基线；其余运行不覆盖已有快照。'); return 0; }
    const baseline = existsSync(snapshotPath) ? json(snapshotPath) : null;
    baselineState = { present: !!baseline, reviewed: baseline?.reviewed === true, schemaVersion: baseline?.schemaVersion ?? null, version: baseline?.version ?? null };
    temp = mkdtempSync(join(tmpdir(), 'coda-pi-compat-'));
    const env = minimalEnv(temp);
    let command = options.pi ? resolve(options.pi) : findPi(JSON.parse(process.env.CODA_PLUGIN_SETTINGS || '{}'));
    if (options.install) {
      const node = process.env.CODA_NODE || process.execPath;
      const npm = join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
      if (!existsSync(npm)) throw new Error(`当前 Node 没带 npm：${npm}`);
      const prefix = join(temp, 'prefix');
      if (options.install === VERIFIED_PI_VERSION) {
        prepareRuntime(prefix);
        await run(node, [npm, 'ci', '--cache', join(temp, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier'], { cwd: prefix, env, timeout: 540000 });
        command = join(prefix, 'node_modules/.bin/pi');
      } else {
        await run(node, [npm, 'install', '--global', '--prefix', prefix, '--cache', join(temp, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', `${PACKAGE}@${options.install}`], { cwd: temp, env, timeout: 540000 });
        command = join(prefix, 'bin/pi');
      }
    }
    const { stdout: versionText } = await run(command, ['--version'], { cwd: temp, env, timeout: 15000 });
    const version = parsePiVersion(versionText);
    if (!version) throw new Error(`Pi 版本无法解析：${command}`);
    const packageDir = locatePackage(command);
    if (json(join(packageDir, 'package.json')).version !== version) throw new Error('可执行文件版本与定位到的 npm 包版本不一致');
    const { stdout: help } = await run(command, ['--help'], { cwd: temp, env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    const current = { ...inspectPackage(packageDir, help), version };
    const surface = json(surfacePath);
    const report = { baseline: baselineState, version, command, packageDir, confidence: current.unknown.length ? '低（部分文档回退）' : '高（发布的声明和 CLI 帮助）；复杂类型无法证明时转人工评估', ...compare(surface, current, baseline) };
    const probeResults = await probeFn(command, join(temp, 'probe'), { env, scope });
    for (const name of PROBE_COMMANDS) if (!probeResults?.[name]) throw new Error(`缺少只读探测响应 ${name}`);
    const probed = checkProbe(probeResults, surface);
    report.incompatible.push(...probed.failures); report.passed.push(...probed.passed);
    const changelog = join(packageDir, 'CHANGELOG.md');
    report.changelog = existsSync(changelog) ? changelogBetween(read(changelog), baseline?.version, version) : '';
    if (!existsSync(changelog) && baseline?.version !== version) report.review.push({ message: '候选缺少 CHANGELOG，无法评估版本变化', evidence: packageDir });
    report.changelogSource = existsSync(changelog) ? 'CHANGELOG.md' : null;
    if (baseline && baseline.version !== version && existsSync(changelog)) {
      const headings = [...read(changelog).matchAll(/^##\s+\[?v?(\d+\.\d+\.\d+[^\s\]]*)/gm)].map(m => m[1]);
      if (!headings.includes(baseline.version) || !headings.includes(version)) report.review.push({ message: 'CHANGELOG 缺少版本边界，摘录可能不完整（降级候选也需人工查看）', evidence: 'CHANGELOG.md' });
    }
    const snapshot = { schemaVersion: 1, version, reviewed: !!options.accept, inventory: current.inventory, evidence: current.evidence, signatures: current.signatures };
    if (options.accept && report.incompatible.length) report.review.push({ message: '存在不兼容，未接受快照', evidence: snapshotPath });
    if (options.accept && !report.incompatible.length) {
      // Defer the mutation until every process and temporary directory is cleaned up.
      report.review = report.review.filter(i => !/尚无人确认基线|基线格式缺失或未知|版本漂移|^新增 |^声明变化 /.test(i.message));
      report.accepted = true; report.baseline = { present: true, reviewed: true, schemaVersion: 1, version };
    }
    report.candidateSnapshot = snapshot;
    report.exitCode = report.incompatible.length ? 1 : report.review.length ? 2 : 0;
    // Cleanup is part of inspection: never print an incompatibility before cleanup can fail.
    await scope.cleanup();
    remove(temp, { recursive: true, force: true }); temp = null;
    if (report.accepted) writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Pi ${version}（${command}）\n来源置信度：${report.confidence}\n基线确认：${report.baseline.reviewed ? '已确认' : '待确认'}（schema ${report.baseline.schemaVersion ?? '缺失'}）`);
      for (const [key, title] of [['incompatible', '不兼容'], ['review', '新增待评估'], ['passed', '通过']]) {
        console.log(`\n${title}（${report[key].length}）`);
        for (const row of report[key]) console.log(`- ${row.message}\n  证据：${row.evidence}`);
      }
      if (report.changelog) console.log(`\nCHANGELOG.md（${baseline?.version ?? '无基线'} → ${version}）\n${report.changelog}`);
      console.log(`\n退出码：${report.exitCode}${report.accepted ? '；已接受快照' : ''}`);
    }
    return report.exitCode;
  } catch (error) {
    try { await scope.cleanup(); if (temp) { remove(temp, { recursive: true, force: true }); temp = null; } }
    catch (cleanupError) { error = new Error(`${error.message}；清理失败：${cleanupError.message}`); }
    const result = { baseline: baselineState, exitCode: 3, error: `无法检查：${error.message}` };
    console[options?.json || args.includes('--json') ? 'log' : 'error'](options?.json || args.includes('--json') ? JSON.stringify(result) : `${result.error}\n基线确认：${baselineState.reviewed ? '已确认' : '待确认'}`);
    return 3;
  } finally {
    try { await scope.cleanup(); if (temp) remove(temp, { recursive: true, force: true }); }
    catch (error) { console.error(`无法检查：清理失败：${error.message}`); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
