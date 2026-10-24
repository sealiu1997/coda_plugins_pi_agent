// Pi's effective startup defaults for a session, captured from its first state and kept per session
// so respawn and session/load restore the same「Pi 默认」baseline. What Pi reported is authoritative:
// it has already applied trust rules, settings merging and its built-in defaults.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// File layout: $CODA_PLUGIN_STATE/defaults/<sessionId>.json. Unwritable state means memory only.
const defaultsFile = (stateDir, sessionId) => join(stateDir, 'defaults', `${sessionId}.json`);

export function readSessionDefaults(stateDir, sessionId) {
  try {
    const parsed = JSON.parse(readFileSync(defaultsFile(stateDir, sessionId), 'utf8'));
    return typeof parsed?.model === 'string' || typeof parsed?.thinkingLevel === 'string'
      ? { model: parsed.model ?? null, thinkingLevel: parsed.thinkingLevel ?? null }
      : null;
  } catch {
    return null;
  }
}

export function writeSessionDefaults(stateDir, sessionId, { model, thinkingLevel }) {
  try {
    mkdirSync(join(stateDir, 'defaults'), { recursive: true });
    writeFileSync(defaultsFile(stateDir, sessionId), JSON.stringify({ model: model ?? null, thinkingLevel: thinkingLevel ?? null }));
    return true;
  } catch {
    return false;
  }
}
