// Session titles: Pi never names a session on its own (its TUI asks the user to /name one),
// so the plugin asks the model itself once, after the session's first finished turn, the way
// Coda's Claude plugin does with the SDK's title generator: the first user message and the
// first reply, summarized to a short title. The summary is a `pi --print` child of its own
// (`--no-session`: it leaves no trace in the session the user sees), never runs tools, and
// takes the same model the session just used. What it answers is set as the Pi session's
// name (`set_session_name`), and Pi's `session_info_changed` hands it to Coda from there.
import { spawn } from 'node:child_process';
import { envForPi } from './pi-env.mjs';

const TITLE_TIMEOUT = 30000;
const TITLE_PROMPT = '用一句话给下面的对话起一个不超过 16 个字的中文会话标题。只回答标题本身，不要任何解释、引号或标点结尾。';

const firstText = (blocks, limit) => {
  const text = (blocks ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

// The text a title is made of: the first prompt and the first reply, cut short. Null when
// there is not enough to name anything yet.
export function titleMaterial(firstPrompt, firstReply) {
  const user = firstText(firstPrompt, 600);
  const reply = firstText(firstReply, 400);
  if (user.length < 3) return null;
  return `用户：${user}${reply ? `\n回复：${reply}` : ''}`;
};

// A short title for the dialogue, from a `pi --print` child. Resolves null when the child
// fails, times out, or answers nothing usable: a session without a title is a session the
// user can still name, never a reason to fail anything else.
export async function generateTitle(piCommand, cwd, model, dialogue, { timeout = TITLE_TIMEOUT, spawnFn = spawn, env = process.env, node } = {}) {
  if (!dialogue) return null;
  const args = [
    '--print', '--mode', 'text', '--no-session', '--no-tools', '--no-extensions', '--no-mcp',
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--thinking', 'off',
  ];
  if (model) args.push('--model', model);
  args.push(`${TITLE_PROMPT}\n\n${dialogue}`);
  return new Promise(resolve => {
    let child;
    try {
      child = spawnFn(piCommand, args, { cwd, env: envForPi(env, piCommand, node), stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '', done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      try { child.kill('SIGKILL'); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    child.stdout?.on('data', chunk => { out += chunk; });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const text = out.replace(/\s+/g, ' ').trim().replace(/^["'“”«»]+|["'“”«»]+$/g, '');
      finish(text && text.length <= 80 ? text : null);
    });
  });
}
