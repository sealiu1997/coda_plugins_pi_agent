// The environment a Pi child of this plugin runs with: the agent process's own, with the
// directories of `pi` itself and of Coda's Node (`$CODA_NODE`) on the PATH, so a pi found
// outside the PATH keeps working and pi's npm-installed peers resolve.
import { envForPiCommand } from './pi-command.mjs';

export function envForPi(env, piCommand, node = process.execPath) {
  return envForPiCommand(env, piCommand, node);
}
