// Bounded process-group ownership for compatibility/probe tooling (POSIX, as Pi/Coda).
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export class ProcessScope {
  constructor() { this.children = new Set(); this.controller = new AbortController(); }
  listen() {
    this.onSignal = signal => this.controller.abort(new Error(`检查被 ${signal} 中断`));
    this.int = () => this.onSignal('SIGINT'); this.term = () => this.onSignal('SIGTERM');
    process.on('SIGINT', this.int); process.on('SIGTERM', this.term);
    return this;
  }
  track(child, grace = 500) {
    const entry = { child, grace, closed: false };
    entry.done = new Promise(resolve => {
      child.once('close', () => { entry.closed = true; resolve(); });
      child.once('error', () => { if (child.pid === undefined) { entry.closed = true; resolve(); } });
    });
    this.children.add(entry); return entry;
  }
  signal(entry, signal) {
    try {
      if (entry.child.pid !== undefined) process.kill(-entry.child.pid, signal);
      else if (!entry.closed) entry.child.kill(signal); // injected test child
    } catch (e) { if (e.code !== 'ESRCH') throw new Error(`进程组清理失败：${e.message}`); }
  }
  alive(entry) {
    if (entry.child.pid === undefined) return !entry.closed;
    try { process.kill(-entry.child.pid, 0); return true; }
    catch (e) { if (e.code === 'ESRCH') return false; throw e; }
  }
  async stop(entry) {
    this.signal(entry, 'SIGTERM');
    const deadline = Date.now() + entry.grace;
    while (this.alive(entry) && Date.now() < deadline) await delay(20);
    if (this.alive(entry)) this.signal(entry, 'SIGKILL');
    let timer;
    try {
      await Promise.race([entry.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('进程组清理失败：KILL 后未关闭')), 2000); })]);
    } finally { clearTimeout(timer); this.children.delete(entry); }
  }
  async run(command, args, { timeout = 30000, maxBuffer = 8 * 1024 * 1024, grace = 500, ...options } = {}) {
    this.controller.signal.throwIfAborted();
    const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = this.track(child, grace); let stdout = '', stderr = '', timer;
    try {
      return await new Promise((resolve, reject) => {
        const abort = () => reject(this.controller.signal.reason);
        this.controller.signal.addEventListener('abort', abort, { once: true });
        const finish = fn => value => { this.controller.signal.removeEventListener('abort', abort); fn(value); };
        child.on('error', finish(reject));
        child.stdout.on('data', data => { if (stdout.length + data.length > maxBuffer) reject(new Error('子进程输出超限')); else stdout += data; });
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-maxBuffer); });
        child.on('close', (code, signal) => code === 0 ? finish(resolve)({ stdout, stderr }) : finish(reject)(Object.assign(new Error(`${command} 退出 ${code ?? signal}：${stderr}`), { stdout, stderr, exitCode: code })));
        timer = setTimeout(() => reject(new Error(`${command} 超时`)), timeout);
      });
    } finally { clearTimeout(timer); await this.stop(entry); }
  }
  async cleanup() {
    const results = await Promise.allSettled([...this.children].map(entry => this.stop(entry)));
    if (this.int) { process.off('SIGINT', this.int); process.off('SIGTERM', this.term); }
    const failure = results.find(r => r.status === 'rejected'); if (failure) throw failure.reason;
  }
}
export const minimalEnv = directory => ({ PATH: `${process.execPath.slice(0, process.execPath.lastIndexOf('/'))}:${process.env.PATH ?? ''}`,
  HOME: directory, TMPDIR: directory, NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: `${directory}/empty-global.npmrc`,
  PI_CODING_AGENT_DIR: directory, PI_CODING_AGENT_SESSION_DIR: `${directory}/sessions`, PI_OFFLINE: '1', PI_TELEMETRY: '0' });
