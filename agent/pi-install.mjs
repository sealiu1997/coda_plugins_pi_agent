// The verified npm graph travels with the plugin for deterministic compatibility scans. Runtime setup
// deliberately installs npm latest so the Coda plugin can manage the user's Pi version.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE } from './pi-command.mjs';
export const runtimeSeed = join(dirname(fileURLToPath(import.meta.url)), 'pi-install');
export function prepareRuntime(prefix, latest = false) {
  mkdirSync(prefix, { recursive: true });
  if (latest) {
    writeFileSync(join(prefix, 'package.json'), JSON.stringify({ private: true, dependencies: { [PACKAGE]: 'latest' } }));
    rmSync(join(prefix, 'package-lock.json'), { force: true });
  } else {
    for (const name of ['package.json', 'package-lock.json']) cpSync(join(runtimeSeed, name), join(prefix, name));
  }
}
