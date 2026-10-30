// The environment a Pi child of this plugin runs with: the agent process's own, with the
// directories of `pi` itself and of Coda's Node (`$CODA_NODE`) on the PATH, so a pi found
// outside the PATH keeps working and pi's npm-installed peers resolve.
import { delimiter, dirname, isAbsolute } from 'node:path';
import { normalizePiLaunch } from './pi-command.mjs';

export function envForPi(env, piCommand, node = process.execPath) {
  const next = { ...env };
  let pathVal = next.PATH || '';
  const command = normalizePiLaunch(piCommand).command;
  if (isAbsolute(command)) {
    const piDir = dirname(command);
    if (!pathVal.split(delimiter).includes(piDir)) pathVal = `${piDir}${delimiter}${pathVal}`;
  }
  const nodeDir = dirname(node);
  if (!pathVal.split(delimiter).includes(nodeDir)) pathVal = `${nodeDir}${delimiter}${pathVal}`;
  next.PATH = pathVal;
  return next;
}
