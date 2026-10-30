#!/usr/bin/env node
// Compare published plugin contents with Coda's checker and a human-reviewed protocol baseline.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'https://github.com/coda-console/coda-plugins.git';
const DOC = 'docs/agent-protocol.md';
const CONTRACT = 'check/coda/contract.json';
const hash = text => createHash('sha256').update(text).digest('hex');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const json = async path => JSON.parse(await readFile(path, 'utf8'));

export function sectionsOf(document) {
  const sections = [], stack = [], counts = new Map();
  let current = null, fence = null;
  for (const line of document.replace(/\r\n/g, '\n').split('\n')) {
    const fenced = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenced) {
      if (!fence) fence = fenced[1];
      else if (fenced[1][0] === fence[0] && fenced[1].length >= fence.length) fence = null;
      current?.lines.push(line); continue;
    }
    const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const depth = heading[1].length, title = heading[2];
      while (stack.length && stack.at(-1).depth >= depth) stack.pop();
      stack.push({ depth, title });
      const path = stack.map(item => item.title).join(' / ');
      const occurrence = (counts.get(path) ?? 0) + 1; counts.set(path, occurrence);
      current = { title: path, key: `${path} [${occurrence}]`, lines: [] }; sections.push(current);
    } else {
      if (!current) { current = { title: '文档前言', key: '文档前言 [1]', lines: [] }; sections.push(current); }
      current.lines.push(line);
    }
  }
  return sections.map(({ lines, ...section }) => ({ ...section, text: lines.join('\n').trim(), hash: hash(lines.join('\n').trim()), characters: lines.join('\n').trim().length }));
}

// Explicit namespaces are high confidence. Contextual capability names are medium confidence.
export function identifiersOf(document, ignored = []) {
  const found = new Map(), ignore = new Set(ignored);
  const add = (id, section, confidence, rule) => {
    if (ignore.has(id)) return;
    const item = found.get(id) ?? { id, confidence, rule, sections: [] };
    if (!item.sections.includes(section)) item.sections.push(section);
    found.set(id, item);
  };
  for (const section of sectionsOf(document)) {
    const text = `${section.title}\n${section.text}`;
    // Scan inline code plus JSON protocol discriminants; never arbitrary prose words.
    const candidates = [...text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map(m => m[1]);
    candidates.push(...[...text.matchAll(/"(?:method|sessionUpdate|kind)"\s*:\s*"([\w$./-]+)"/g)].map(m => m[1]));
    for (const candidate of candidates) {
      const tokens = candidate.match(/(?:_coda\/[\w/-]+|_session\/[\w/-]+|\$\/cancel_request|(?:session|elicitation)\/[a-z][\w/]*|(?:[\w]+\.)*_meta\.(?:coda|steering)(?:\.[A-Za-z][\w]*)+|contributes\.[A-Za-z][\w.]*)\b/g) ?? [];
      for (const id of tokens) add(id.includes('_meta.') ? id.slice(id.indexOf('_meta.')) : id, section.title, '高', '明确协议命名空间');
      for (const token of candidate.match(/[A-Za-z_$][\w.$/-]*/g) ?? []) {
        if (/^[a-z]+(?:_[a-z]+)*_(?:update|chunk)$/.test(token) || /^(?:tool_call|quota_exhausted|service_unavailable|auth_required|coda-model-[a-z-]+)$/.test(token)) {
          add(token, section.title, '高', '更新种类、失败分类或配置 format');
        } else if (/^(?:(?:clientCapabilities|agentCapabilities)\.[\w.]+|(?:sessionCapabilities|promptCapabilities|mcpCapabilities)\.[\w.]+|elicitation\.(?:form|url)|session\.(?:compaction|configOptions\.[\w]+)|loadSession|systemPrompt|configOptions|additionalDirectories)$/.test(token)) {
          add(token, section.title, '中', '能力或协商字段形状');
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function referencesOf(id, sources) {
  const literal = new RegExp(`(?<![\\w$./-])${escape(id)}(?![\\w$./-])`);
  // Nested object notation is only a reference hint, not proof of implemented behavior.
  const nested = id.includes('.') ? new RegExp(id.split('.').map(escape).join(`[\\s'"{}:.,?]*`)) : null;
  return Object.entries(sources).flatMap(([file, text]) => {
    let match = literal.exec(text) ?? nested?.exec(text);
    if (!match && file === 'package.json' && id.startsWith('contributes.')) {
      const hasPath = (value, keys) => !keys.length || (Array.isArray(value)
        ? value.some(item => hasPath(item, keys))
        : value != null && typeof value === 'object' && Object.hasOwn(value, keys[0]) && hasPath(value[keys[0]], keys.slice(1)));
      if (hasPath(JSON.parse(text), id.split('.'))) {
        const key = new RegExp(`"${escape(id.split('.').at(-1))}"\\s*:`).exec(text);
        if (key) match = key;
      }
    }
    return match ? [{ file, line: text.slice(0, match.index).split('\n').length, match: match[0] }] : [];
  });
}

export function parseChecker(stdout, status) {
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, ''), items = [];
  let scope = '';
  const marks = { '✓': 'pass', '✗': 'fail', '!': 'warn', '-': 'skip', '·': 'info' };
  for (const raw of clean.split('\n')) {
    if (raw.startsWith('结果：')) break;
    const item = raw.match(/^  ([✓✗!\-·]) (.*)$/);
    if (item) items.push({ status: marks[item[1]], scope, message: item[2], raw });
    else if (/^(清单|握手|一轮)(?: · .+)?$/.test(raw)) scope = raw;
    else if (items.length) { items.at(-1).message += `\n${raw}`; items.at(-1).raw += `\n${raw}`; }
  }
  for (const item of items) { item.message = item.message.trimEnd(); item.raw = item.raw.trimEnd(); }
  const summary = clean.match(/^结果：(通过|不通过)（通过 (\d+)，失败 (\d+)，跳过 (\d+)，提醒 (\d+)）$/m);
  if (!summary || ![0, 1].includes(status) || !items.length) throw new Error('检查器输出无法识别或异常退出，不能判为兼容');
  for (const [i, type] of ['pass', 'fail', 'skip', 'warn'].entries()) {
    if (items.filter(item => item.status === type).length !== Number(summary[i + 2])) throw new Error('检查器输出计数不一致');
  }
  if ((items.some(item => item.status === 'fail') ? 1 : 0) !== status || (summary[1] === '不通过') !== (status === 1)) throw new Error('检查器结论与退出码不一致');
  return { items, stdout, status };
}

export function compare(baseline, latest, sources) {
  const before = new Map((baseline?.sections ?? []).map(s => [s.key, s]));
  const after = new Map(latest.sections.map(s => [s.key, s]));
  const changes = [];
  if (baseline) {
    for (const section of latest.sections) {
      const old = before.get(section.key);
      if (!old || old.hash !== section.hash) {
        const previous = new Set(baseline.identifiers.filter(item => item.sections.includes(section.title)).map(item => item.id));
        const current = new Set(latest.identifiers.filter(item => item.sections.includes(section.title)).map(item => item.id));
        const added = [...current].filter(id => !previous.has(id)), removed = [...previous].filter(id => !current.has(id));
        const delta = [added.length ? `新增标识符 ${added.join('、')}` : '', removed.length ? `移除标识符 ${removed.join('、')}` : ''].filter(Boolean).join('；');
        changes.push({ title: section.title, kind: old ? '变更' : '新增', summary: old
          ? `正文变化${old.characters != null ? `（${old.characters} → ${section.characters} 字符）` : ''}；${delta || '抽取的协议标识符未变'}`
          : `新增协议章节${delta ? `；${delta}` : ''}` });
      }
    }
    for (const section of baseline.sections) if (!after.has(section.key)) changes.push({ title: section.title, kind: '删除', summary: '协议章节已移除或改名' });
  }
  const oldIds = new Map((baseline?.identifiers ?? []).map(item => [item.id, item]));
  const newIds = new Set(latest.identifiers.map(item => item.id));
  const added = baseline ? latest.identifiers.filter(item => !oldIds.has(item.id) && !referencesOf(item.id, sources).length) : [];
  const removed = baseline ? baseline.identifiers.filter(item => !newIds.has(item.id)).flatMap(item => {
    const evidence = referencesOf(item.id, sources);
    return evidence.length ? [{ ...item, evidence }] : [];
  }) : [];
  return { changes, added, removed, contractChanged: !!baseline && baseline.contractHash !== latest.contractHash };
}

export async function run(command, args, { cwd, timeout = 120_000 } = {}) {
  return new Promise((done, reject) => execFile(command, args, {
    cwd, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', npm_config_update_notifier: 'false' },
  }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== 'number')) reject(new Error(`${command} 执行失败：${error.message}`));
    else done({ status: error?.code ?? 0, stdout, stderr });
  }));
}
async function required(runner, command, args, options) {
  const result = await runner(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（${result.status}）：${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

export async function fetchUpstream({ directory, ref, baseline, runner }) {
  const cwd = join(directory, 'upstream');
  await required(runner, 'git', ['clone', '--depth', '1', '--branch', 'main', UPSTREAM, cwd], { timeout: 120_000 });
  if (ref !== 'main') {
    await required(runner, 'git', ['fetch', '--depth', '1', 'origin', ref], { cwd });
    await required(runner, 'git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd });
  }
  const commit = await required(runner, 'git', ['rev-parse', 'HEAD'], { cwd });
  let history = [];
  if (baseline && baseline.upstreamCommit !== commit) {
    // A shallow clone cannot establish the range; fetch read-only history before logging it.
    if (!/^[a-f0-9]{40}$/.test(baseline.upstreamCommit)) throw new Error('基线里的上游提交格式无效');
    await required(runner, 'git', ['fetch', '--unshallow', 'origin'], { cwd });
    const log = await required(runner, 'git', ['log', '--format=%H%x09%s', `${baseline.upstreamCommit}..${commit}`, '--', DOC, 'check/coda/'], { cwd });
    history = log ? log.split('\n').map(line => { const [commit, ...title] = line.split('\t'); return { commit, title: title.join('\t') }; }) : [];
  }
  return { cwd, commit, history, document: await readFile(join(cwd, DOC), 'utf8'), contract: await json(join(cwd, CONTRACT)) };
}

async function sourceFiles(root) {
  const sources = { 'package.json': await readFile(join(root, 'package.json'), 'utf8') };
  const walk = async dir => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) sources[path] = await readFile(join(root, path), 'utf8');
    }
  };
  await walk('agent');
  return sources;
}

export async function check({ root = ROOT, ref = 'main', manifest = false, live = false, accept = false } = {},
  { runner = run, fetcher = fetchUpstream } = {}) {
  let directory;
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node ≥24');
    if (manifest && live) throw new Error('--manifest 与 --live 不能同时使用');
    if (!ref || ref.startsWith('-')) throw new Error('--ref 不能是空值或选项');
    const baselinePath = join(root, 'compat/coda-baseline.json');
    let baseline;
    try { baseline = await json(baselinePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const ignore = await json(join(root, 'compat/coda-ignore.json'));
    if (!Array.isArray(ignore.identifiers) || ignore.identifiers.some(id => typeof id !== 'string')) throw new Error('忽略名单格式无效');
    directory = await mkdtemp(join(tmpdir(), 'pi-coda-compat-'));
    const upstream = await fetcher({ directory, ref, baseline, runner });
    if (!/^[a-f0-9]{40}$/.test(upstream.commit) || !/^[a-f0-9]{40}$/.test(upstream.contract.commit)) throw new Error('上游或 Coda 契约提交缺失/格式无效');
    const latest = { schemaVersion: 1, upstreamCommit: upstream.commit, codaCommit: upstream.contract.commit,
      contractHash: hash(JSON.stringify(upstream.contract)),
      sections: sectionsOf(upstream.document).map(({ text, ...section }) => section),
      identifiers: identifiersOf(upstream.document, ignore.identifiers) };
    const comparedBaseline = baseline ? { ...baseline, identifiers: baseline.identifiers.filter(item => !ignore.identifiers.includes(item.id)) } : null;
    const diff = compare(comparedBaseline, latest, await sourceFiles(root));
    const packOutput = JSON.parse(await required(runner, 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', join(directory, 'npm-cache')], { cwd: root }));
    const packed = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
    if (packed.length !== 1 || !Array.isArray(packed[0].files) || !packed[0].files.length) throw new Error('npm pack 未返回发布文件清单');
    const plugin = join(directory, 'plugin'); await mkdir(plugin);
    const rootReal = await realpath(root);
    for (const { path } of packed[0].files) {
      if (typeof path !== 'string' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`不安全的发布路径：${path}`);
      const source = await realpath(join(root, path)), rel = relative(rootReal, source);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`发布文件越界：${path}`);
      await mkdir(dirname(join(plugin, path)), { recursive: true });
      await cp(source, join(plugin, path));
    }
    await required(runner, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(directory, 'npm-cache')], { cwd: upstream.cwd, timeout: 180_000 });
    const result = await runner(process.execPath, ['bin/check.mjs', plugin, ...(manifest ? ['--manifest'] : []), ...(live ? ['--live'] : [])],
      { cwd: upstream.cwd, timeout: live ? 20 * 60_000 : 180_000 });
    const checker = parseChecker(result.stdout, result.status);
    checker.stderr = result.stderr;
    const incompatible = checker.items.some(item => ['fail', 'warn'].includes(item.status)) || diff.removed.length > 0;
    const review = !baseline || baseline.reviewed === false || diff.changes.length > 0 || diff.added.length > 0 || diff.contractChanged;
    const report = { exitCode: incompatible ? 1 : review ? 2 : 0, mode: manifest ? 'manifest' : live ? 'live' : 'handshake',
      upstream: { commit: upstream.commit, codaCommit: latest.codaCommit, ref }, baseline: baseline?.upstreamCommit ?? null,
      baselineAction: !baseline ? (accept ? '首次生成且已接受当前协议基线' : '首次生成，尚未人工确认，请阅读后运行 --accept') : accept ? '已接受当前协议基线（检查结论仍保留）' : '保留原基线',
      confidence: '高：明确命名空间、更新种类、失败分类及 coda-model-*；中：能力协商字段。引用匹配含注释与嵌套对象，仅为文本证据；未引用不等于必须适配，消失不等于已被 Coda 禁止。',
      publishedFiles: packed[0].files.map(file => file.path), checker, ...diff, history: upstream.history };
    if (!baseline || accept) {
      await mkdir(dirname(baselinePath), { recursive: true });
      await writeFile(baselinePath, `${JSON.stringify({ ...latest, reviewed: accept }, null, 2)}\n`);
    }
    return report;
  } catch (error) {
    return { exitCode: 3, error: error.message };
  } finally {
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (error) { return { exitCode: 3, error: `清理临时目录 ${directory} 失败：${error.message}` }; }
    }
  }
}

export function formatReport(report) {
  if (report.exitCode === 3) return `无法检查：${report.error}`;
  const lines = [`Coda 兼容性检查：${['兼容且无新增', '有不兼容或风险', '兼容，协议变化待评估'][report.exitCode]}`,
    `上游 ${report.upstream.commit} · Coda ${report.upstream.codaCommit} · ${report.mode}`, report.baselineAction, '', '不兼容 / 风险'];
  const risks = report.checker.items.filter(item => ['fail', 'warn'].includes(item.status));
  for (const item of risks) lines.push(`- [${item.scope}] ${item.raw.trim()}（插件：package.json / agent/**，发布副本）`);
  for (const item of report.removed) lines.push(`- 协议标识符消失：${item.id}；原章节：${item.sections.join('、')}；引用：${item.evidence.map(e => `${e.file}:${e.line}`).join('、')}`);
  if (!risks.length && !report.removed.length) lines.push('- 无');
  lines.push('', '新增待评估 / 协议变化');
  for (const item of report.added) lines.push(`- ${item.id}（置信度${item.confidence}）；章节：${item.sections.join('、')}；agent/**、package.json 未找到引用`);
  for (const item of report.changes) lines.push(`- ${item.kind}章节「${item.title}」：${item.summary}`);
  if (report.contractChanged) lines.push('- check/coda/contract.json 变化：Coda 规则或依赖快照已更新');
  if (!report.added.length && !report.changes.length && !report.contractChanged) lines.push(report.exitCode === 2 ? '- 首次基线或未确认基线，需人工确认' : '- 无');
  lines.push('', '通过 / 跳过 / 信息');
  for (const item of report.checker.items.filter(item => !['fail', 'warn'].includes(item.status))) lines.push(`- [${item.scope}] ${item.raw.trim()}`);
  lines.push('', '上游提交上下文');
  for (const item of report.history) lines.push(`- ${item.commit.slice(0, 12)} ${item.title}`);
  if (!report.history.length) lines.push('- 无（首次基线或提交范围内没有相关变更）');
  lines.push('', report.confidence, '默认只验证清单与握手；跳过项不代表通过，--live 会真正发提示词。');
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2), dependencies) {
  let options;
  try {
    options = parseArgs({ args, options: { ref: { type: 'string', default: 'main' }, manifest: { type: 'boolean' }, live: { type: 'boolean' }, accept: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }).values;
  } catch (error) {
    process.stdout.write(args.includes('--json') ? `${JSON.stringify({ exitCode: 3, error: error.message })}\n` : `无法检查：${error.message}\n`); return 3;
  }
  if (options.help) {
    process.stdout.write('用法：node scripts/check-coda-compat.mjs [--ref 提交或分支] [--manifest | --live] [--json] [--accept]\n退出码：0 兼容无新增；1 不兼容/风险；2 协议变化待评估；3 无法检查。\n首次生成未确认基线；人工阅读后用 --accept 更新。临时克隆及依赖安装均会清理。\n'); return 0;
  }
  const report = await check(options, dependencies);
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`);
  return report.exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
