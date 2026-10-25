// The environment a Pi child of this plugin runs with: the agent process's own, with the
// directories of `pi` itself and of Coda's Node (`$CODA_NODE`) on the PATH, so a pi found
// outside the PATH keeps working and pi's npm-installed peers resolve.
import { dirname, isAbsolute } from 'node:path';

export function envForPi(env, piCommand, node = process.execPath) {
  const next = { ...env };
  let pathVal = next.PATH || '';
  if (isAbsolute(piCommand)) {
    const piDir = dirname(piCommand);
    if (!pathVal.split(':').includes(piDir)) pathVal = `${piDir}:${pathVal}`;
  }
  const nodeDir = dirname(node);
  if (!pathVal.split(':').includes(nodeDir)) pathVal = `${nodeDir}:${pathVal}`;
  next.PATH = pathVal;
  return next;
}
