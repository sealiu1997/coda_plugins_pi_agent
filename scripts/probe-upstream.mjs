// Advisory scheduled/manual orchestration, never a PR gate or a second protocol checker.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessScope, minimalEnv } from './process-scope.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'compat-reports'));
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), 'pi-upstream-')), scope = new ProcessScope().listen();
const node = process.env.CODA_NODE || process.execPath;
const env = { ...minimalEnv(temp), PATH: `${dirname(node)}:${minimalEnv(temp).PATH}` }, results = [];
const npm = join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
const run = (command, args, options = {}) => scope.run(command, args, { cwd: temp, env, timeout: 120000, grace: 3000, ...options });
const save = (name, text) => writeFileSync(join(output, name), text);
try {
  try {
    const pinned = JSON.parse(readFileSync(join(root, 'package.json'))).devDependencies['@coda-console/plugin-check'];
    const metadata = async spec => JSON.parse((await run(node, [npm, 'view', `@coda-console/plugin-check@${spec}`, 'version', 'gitHead', '--json'])).stdout);
    const stable = await metadata(pinned), latest = await metadata('latest');
    for (const info of [stable, latest]) if (!/^[a-f0-9]{40}$/.test(info.gitHead)) throw new Error('npm 未提供有效上游提交，无法核对协议');
    try {
      const repo = join(temp, 'upstream');
      await run('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/coda-console/coda-plugins.git', repo]);
      const upstreamCommit = (await run('git', ['rev-parse', 'origin/main'], { cwd: repo })).stdout.trim();
      const doc = 'docs/agent-protocol.md';
      const diff = (await run('git', ['diff', `${stable.gitHead}..${upstreamCommit}`, '--', doc], { cwd: repo })).stdout;
      const releaseDiff = (await run('git', ['diff', `${stable.gitHead}..${latest.gitHead}`, '--', doc], { cwd: repo })).stdout;
      const commits = (await run('git', ['log', '--format=%H %s', `${stable.gitHead}..${upstreamCommit}`, '--', doc], { cwd: repo })).stdout;
      save('coda-upstream.json', JSON.stringify({ stable, latest, upstreamCommit, protocol: doc, protocolChanged: !!diff }, null, 2));
      save('agent-protocol.diff', diff || 'No protocol changes.\n');
      save('agent-protocol-release.diff', releaseDiff || 'No protocol changes.\n');
      save('agent-protocol-commits.txt', commits || 'No protocol commits.\n');
      results.push({ name: 'Coda upstream protocol', status: diff ? 'review' : 'pass', detail: `${stable.gitHead} → ${upstreamCommit}; latest ${latest.version} (${latest.gitHead}); docs diff saved` });
    } catch (error) {
      save('protocol-error.txt', error.message);
      results.push({ name: 'Coda upstream protocol', status: 'alert', detail: error.message });
    }
    const prefix = join(temp, 'latest-checker');
    mkdirSync(prefix);
    await run(node, [npm, 'install', '--cache', join(temp, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', `@coda-console/plugin-check@${latest.version}`], { cwd: prefix, timeout: 540000 });
    const checked = await run(node, [join(root, 'scripts/check-fake-live.mjs'), '--checker', join(prefix, 'node_modules/@coda-console/plugin-check/bin/check.mjs')], { timeout: 90000 });
    save('coda-latest-live.txt', checked.stdout);
    results.push({ name: 'Coda latest official checker', status: 'pass', detail: latest.version });
  } catch (error) { save('coda-error.txt', `${error.message}\n${error.stdout || ''}`); results.push({ name: 'Coda latest', status: 'alert', detail: error.message }); }
  try {
    const checked = await run(node, [join(root, 'scripts/check-pi-compat.mjs'), '--install', 'latest', '--json'], { timeout: 600000 });
    save('pi-latest.json', checked.stdout); results.push({ name: 'Pi latest', status: 'pass' });
  } catch (error) {
    // Runner errors include stderr; keep structured stdout too when inspection returned 1/2/3.
    save('pi-latest.json', error.stdout || JSON.stringify({ exitCode: 3, error: error.message }, null, 2));
    results.push({ name: 'Pi latest', status: 'alert', detail: 'See pi-latest.json (changes, incompatibility or unable to inspect).' });
  }
} finally {
  try { await scope.cleanup(); } finally { rmSync(temp, { recursive: true, force: true }); }
}
save('summary.json', JSON.stringify(results, null, 2));
const summary = `## Upstream compatibility probe (advisory)\n\n${results.map(r => `- ${r.status === 'pass' ? '✅' : '⚠️'} **${r.name}**: ${r.status}${r.detail ? ` — ${r.detail.slice(0, 1000)}` : ''}`).join('\n')}\n\nProtocol commits and docs/agent-protocol.md diffs are in the artifact. Review before updating pinned versions or accepting Pi snapshots.\n`;
save('summary.md', summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
if (results.some(r => r.status !== 'pass')) { console.log('::warning::Upstream changes or inspection failures need review; see compatibility artifact.'); process.exitCode = 1; }
