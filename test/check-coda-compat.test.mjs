import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { check, compare, fetchUpstream, formatReport, identifiersOf, parseChecker, referencesOf, sectionsOf } from '../scripts/check-coda-compat.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const DOCUMENT = '# Agent\n\n## 协商\n`session/new`、`_session/steering`、`_meta.coda.waits`、`loadSession`。\n\n## 配置\n`contributes.agents`、`coda-model-url`。\n';
const OUTPUT = '检查器标题\n\n清单\n  ✓ package.json 可读\n\n握手 · Agent pi\n  ✓ initialize 正常\n  - 未运行一轮\n  · 未声明活动\n\n结果：通过（通过 2，失败 0，跳过 1，提醒 0）\n';
const WARN = OUTPUT.replace('  · 未声明活动', '  ! 请核查输出').replace('提醒 0', '提醒 1');
const FAIL = OUTPUT.replace('  ✓ initialize 正常', '  ✗ session/new 缺模型\n    模型是必填项').replace('结果：通过（通过 2，失败 0', '结果：不通过（通过 1，失败 1');

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-compat-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agent')); await mkdir(join(root, 'compat'));
  await writeFile(join(root, 'package.json'), '{"name":"test","contributes":{"agents":[]}}');
  await writeFile(join(root, 'agent/entry.mjs'), "const method = 'session/new'; const _meta = { coda: { waits: {} } };\n");
  await writeFile(join(root, 'compat/coda-ignore.json'), '{"identifiers":[]}');
  const calls = [], temporary = [];
  const fetcher = async ({ directory, ref, baseline }) => {
    temporary.push(directory);
    if (options.fetchError) throw new Error('git clone 失败：测试网络故障');
    const cwd = join(directory, 'upstream'); await mkdir(cwd);
    return { cwd, commit: options.commit ?? A, document: options.document ?? DOCUMENT, contract: { commit: B, files: options.files ?? {} },
      history: baseline ? [{ commit: A, title: 'sync/coda: 协议变化' }] : [] };
  };
  const runner = async (command, args, runOptions) => {
    calls.push({ command, args, ...runOptions });
    if (command === 'npm' && args[0] === 'pack') {
      const pkg = { files: (options.packPaths ?? ['package.json', 'agent/entry.mjs']).map(path => ({ path })) };
      return { status: 0, stdout: JSON.stringify(options.objectPack ? { test: pkg } : [pkg]), stderr: '' };
    }
    if (command === 'npm' && args[0] === 'ci') return { status: options.ciFail ? 1 : 0, stdout: '', stderr: options.ciFail ? 'npm ci 被拦' : '' };
    assert.equal(command, process.execPath); assert.equal(args[0], 'bin/check.mjs');
    assert.equal(await readFile(join(args[1], 'agent/entry.mjs'), 'utf8'), await readFile(join(root, 'agent/entry.mjs'), 'utf8'));
    await assert.rejects(access(join(args[1], 'compat/coda-ignore.json')));
    return { status: options.checkStatus ?? 0, stdout: options.output ?? OUTPUT, stderr: '诊断日志' };
  };
  return { root, calls, temporary, dependencies: { runner, fetcher } };
}

function snapshot(document) {
  return { sections: sectionsOf(document).map(({ text, ...s }) => s), identifiers: identifiersOf(document), contractHash: 'same' };
}

test('章节按完整标题路径与重复序号区分，忽略代码围栏里的标题', () => {
  const sections = sectionsOf('# Agent\n## A\none\n```md\n# fake\n```\n## A\ntwo\n');
  assert.deepEqual(sections.map(s => s.key), ['Agent [1]', 'Agent / A [1]', 'Agent / A [2]']);
  assert.match(sections[1].text, /# fake/);
  assert.deepEqual(sectionsOf(DOCUMENT), sectionsOf(DOCUMENT.replaceAll('\n', '\r\n')));
});

test('保守抽取命名空间、更新、错误、能力与 format，不收普通代码词', () => {
  const text = DOCUMENT + '\n## 更新\n`usage_update`、`kind: quota_exhausted`、`session.compaction`、`session.configOptions.boolean`、`_coda/session/compact`、`_meta.coda.compact: {}`、`contributes.configuration.properties`、`README.md`、`npm ci`、`default`。\n```json\n{"method":"_coda/wait/stop","sessionUpdate":"tool_call"}\n```';
  const ids = identifiersOf(text);
  for (const id of ['session/new', '_session/steering', '_meta.coda.waits', 'loadSession', 'usage_update', 'quota_exhausted', 'session.compaction', 'session.configOptions.boolean', '_coda/session/compact', '_meta.coda.compact', 'contributes.configuration.properties', '_coda/wait/stop', 'tool_call']) assert.ok(ids.some(item => item.id === id), id);
  for (const id of ['README.md', 'npm', 'ci', 'default']) assert.ok(!ids.some(item => item.id === id));
  assert.equal(ids.find(item => item.id === 'loadSession').confidence, '中');
  assert.equal(ids.find(item => item.id === '_meta.coda.waits').confidence, '高');
  assert.ok(!identifiersOf(text, ['usage_update']).some(item => item.id === 'usage_update'));
});

test('引用有边界、支持嵌套对象并保留文件行号', () => {
  assert.deepEqual(referencesOf('session/new', { a: "'session/newer'" }), []);
  const evidence = referencesOf('_meta.coda.waits', { 'agent/entry.mjs': '\n_meta: { coda: { waits: {} } }' });
  assert.equal(evidence[0].line, 2);
  assert.equal(evidence[0].file, 'agent/entry.mjs');
});

test('解析全部检查状态、原文、多行证据与提醒', () => {
  const result = parseChecker(OUTPUT, 0);
  assert.deepEqual(result.items.map(item => item.status), ['pass', 'pass', 'skip', 'info']);
  assert.equal(result.items[1].scope, '握手 · Agent pi');
  assert.equal(result.items[1].raw, '  ✓ initialize 正常');
  assert.equal(parseChecker(WARN, 0).items[3].status, 'warn');
  assert.match(parseChecker(FAIL, 1).items[1].raw, /模型是必填项/);
});

test('缺汇总、格式漂移、计数或退出码不一致时拒绝假通过', () => {
  for (const [output, status] of [['成功', 0], [OUTPUT, 1], [OUTPUT, 2], [OUTPUT.replace('通过 2', '通过 3'), 0], [OUTPUT.replace('结果：通过', '结果：不通过'), 0]]) assert.throws(() => parseChecker(output, status));
});

test('章节新增变更删除与标识符新增消失分别报告', () => {
  const baseline = snapshot(DOCUMENT);
  const latest = snapshot('# Agent\n## 协商\n`session/new`、`_coda/session/compact`。\n## 新节\n新能力\n');
  const diff = compare(baseline, latest, { 'agent/entry.mjs': "'_session/steering'" });
  assert.deepEqual(new Set(diff.changes.map(s => s.kind)), new Set(['新增', '变更', '删除']));
  assert.deepEqual(diff.added.map(s => s.id), ['_coda/session/compact']);
  assert.deepEqual(diff.removed.map(s => s.id), ['_session/steering']);
  assert.equal(diff.removed[0].evidence[0].file, 'agent/entry.mjs');
  assert.ok(!diff.changes.some(s => 'text' in s));
});

test('源码已引用的新增协议项不提示，未引用的旧能力也不重复提示', () => {
  const latest = snapshot(DOCUMENT + '\n`_coda/session/compact`\n');
  const diff = compare(snapshot(DOCUMENT), latest, { a: "'_coda/session/compact'" });
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test('首次生成未确认基线，默认握手只复制 npm 发布清单，临时目录清理', async t => {
  const f = await fixture(t);
  const report = await check({ root: f.root }, f.dependencies);
  assert.equal(report.exitCode, 2); assert.equal(report.mode, 'handshake');
  assert.deepEqual(report.publishedFiles, ['package.json', 'agent/entry.mjs']);
  assert.equal(report.checker.stderr, '诊断日志');
  const baseline = JSON.parse(await readFile(join(f.root, 'compat/coda-baseline.json'), 'utf8'));
  assert.equal(baseline.reviewed, false); assert.equal(baseline.upstreamCommit, A); assert.equal(baseline.codaCommit, B);
  assert.ok(baseline.sections.every(s => s.hash.length === 64));
  const invocation = f.calls.find(c => c.args[0] === 'bin/check.mjs');
  assert.ok(!invocation.args.includes('--live')); assert.ok(!invocation.args.includes('--manifest'));
  for (const dir of f.temporary) await assert.rejects(access(dir));
});

test('仅 --accept 更新已有基线；人工确认后相同协议退出 0', async t => {
  const f = await fixture(t);
  await check({ root: f.root }, f.dependencies);
  const path = join(f.root, 'compat/coda-baseline.json'), before = await readFile(path, 'utf8');
  assert.equal((await check({ root: f.root }, f.dependencies)).exitCode, 2);
  assert.equal(await readFile(path, 'utf8'), before);
  await check({ root: f.root, accept: true }, f.dependencies);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).reviewed, true);
  const report = await check({ root: f.root }, f.dependencies);
  assert.equal(report.exitCode, 0); assert.match(formatReport(report), /兼容且无新增/);
});

test('新增未引用能力、规则快照变化退出 2，保留基线与提交上下文', async t => {
  const f = await fixture(t); await check({ root: f.root, accept: true }, f.dependencies);
  const path = join(f.root, 'compat/coda-baseline.json'), before = await readFile(path, 'utf8');
  const changed = await fixture(t, { commit: B, document: DOCUMENT + '\n## 压缩\n`_coda/session/compact`\n', files: { new: 'hash' } });
  await writeFile(join(changed.root, 'compat/coda-baseline.json'), before);
  const report = await check({ root: changed.root }, changed.dependencies);
  assert.equal(report.exitCode, 2); assert.ok(report.contractChanged);
  assert.equal(report.added[0].id, '_coda/session/compact'); assert.equal(report.history.length, 1);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.match(formatReport(report), /压缩/);
});

test('消失且被源码引用的协议项退出 1', async t => {
  const f = await fixture(t); await check({ root: f.root, accept: true }, f.dependencies);
  const baseline = JSON.parse(await readFile(join(f.root, 'compat/coda-baseline.json'), 'utf8'));
  baseline.identifiers.push({ id: 'session/old', confidence: '高', sections: ['旧协议'] });
  await writeFile(join(f.root, 'compat/coda-baseline.json'), JSON.stringify(baseline));
  await writeFile(join(f.root, 'agent/entry.mjs'), "'session/old'");
  const report = await check({ root: f.root }, f.dependencies);
  assert.equal(report.exitCode, 1); assert.equal(report.removed[0].id, 'session/old');
});

for (const [name, output, status] of [['提醒', WARN, 0], ['失败', FAIL, 1]]) test(`检查器${name}优先退出 1，原文保留`, async t => {
  const f = await fixture(t, { output, checkStatus: status });
  const report = await check({ root: f.root }, f.dependencies);
  assert.equal(report.exitCode, 1); assert.match(formatReport(report), name === '提醒' ? /请核查输出/ : /缺模型/);
});

for (const option of ['manifest', 'live']) test(`透传 --${option}`, async t => {
  const f = await fixture(t); const report = await check({ root: f.root, [option]: true }, f.dependencies);
  assert.equal(report.exitCode, 2);
  assert.ok(f.calls.find(c => c.args[0] === 'bin/check.mjs').args.includes(`--${option}`));
});

for (const [name, options] of [['克隆', { fetchError: true }], ['依赖安装', { ciFail: true }], ['检查器格式', { output: '未知输出' }], ['发布越界', { packPaths: ['../outside'] }]]) test(`${name}故障退出 3 并清理临时目录`, async t => {
  const f = await fixture(t, options); const report = await check({ root: f.root }, f.dependencies);
  assert.equal(report.exitCode, 3); assert.ok(report.error);
  for (const dir of f.temporary) await assert.rejects(access(dir));
  await assert.rejects(access(join(f.root, 'compat/coda-baseline.json')));
});

test('无效选项不启动网络', async t => {
  const f = await fixture(t);
  assert.equal((await check({ root: f.root, manifest: true, live: true }, f.dependencies)).exitCode, 3);
  assert.equal((await check({ root: f.root, ref: '--bad' }, f.dependencies)).exitCode, 3);
  assert.equal(f.temporary.length, 0);
});

test('真实 fetcher 的 git 编排：浅克隆、指定 ref、补历史、按路径列提交', async t => {
  const base = await mkdtemp(join(tmpdir(), 'pi-fetcher-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const calls = [], cwd = join(base, 'upstream');
  await mkdir(join(cwd, 'docs'), { recursive: true }); await mkdir(join(cwd, 'check/coda'), { recursive: true });
  await writeFile(join(cwd, 'docs/agent-protocol.md'), DOCUMENT); await writeFile(join(cwd, 'check/coda/contract.json'), JSON.stringify({ commit: B }));
  const runner = async (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: args[0] === 'rev-parse' ? B : args[0] === 'log' ? `${B}\tsync/coda: 新契约\n` : '', stderr: '' };
  };
  const result = await fetchUpstream({ directory: base, ref: B, baseline: { upstreamCommit: A }, runner });
  assert.equal(result.commit, B); assert.equal(result.history[0].title, 'sync/coda: 新契约');
  assert.deepEqual(calls[0].args.slice(0, 5), ['clone', '--depth', '1', '--branch', 'main']);
  assert.ok(calls.some(c => c.args.includes('--unshallow')));
  const log = calls.find(c => c.args[0] === 'log').args;
  assert.ok(log.includes(`${A}..${B}`)); assert.deepEqual(log.slice(-2), ['docs/agent-protocol.md', 'check/coda/']);
  assert.ok(calls.every(c => c.command === 'git' && !c.args.includes('push')));
});


test('兼容新版 npm 的对象 JSON 输出', async t => {
  const f = await fixture(t, { objectPack: true });
  assert.equal((await check({ root: f.root }, f.dependencies)).exitCode, 2);
});

test('忽略名单也作用于旧基线，避免误报标识符消失', async t => {
  const f = await fixture(t); await check({ root: f.root, accept: true }, f.dependencies);
  await writeFile(join(f.root, 'compat/coda-ignore.json'), JSON.stringify({ identifiers: ['session/new'] }));
  const result = await check({ root: f.root }, f.dependencies);
  assert.equal(result.exitCode, 0); assert.deepEqual(result.removed, []);
});

test('清单路径证据指向实际 JSON 行，支持嵌套 contributes 路径', () => {
  const source = '{\n  "contributes": {\n    "agents": [{ "skillsDir": ".agents/skills" }]\n  }\n}';
  assert.equal(referencesOf('contributes.agents.skillsDir', { 'package.json': source })[0].line, 3);
  assert.deepEqual(referencesOf('contributes.panels', { 'package.json': source }), []);
});

test('保留未缩进的多行失败原文，元数据路径归一到 _meta 命名空间', () => {
  const output = FAIL.replace('    模型是必填项', '    模型是必填项\n}\n\nNode.js v24');
  assert.match(parseChecker(output, 1).items[1].raw, /}\n\nNode.js v24/);
  const ids = identifiersOf('# Agent\n`error.data._meta.coda.failure`\n').map(item => item.id);
  assert.deepEqual(ids, ['_meta.coda.failure']);
});
