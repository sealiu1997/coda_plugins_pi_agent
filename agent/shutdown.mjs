// Stopping the Pi children: TERM first, then KILL when the grace runs out. A closed stdin
// gets the grace before TERM so Pi can flush and leave on its own. Each close is awaited
// before the ACP process leaves, so no child outlives it.
export async function stopChildren(children, { grace = 500, closeFirst = false } = {}) {
  children = children.filter(pi => pi && !pi.exited);
  if (closeFirst) for (const pi of children) pi.close();
  const within = ms => new Promise(resolve => { setTimeout(resolve, ms); });
  const exitsWithin = (pi, timeout) => pi.exited
    ? Promise.resolve(true)
    : Promise.race([pi.waitForExit().then(() => true), within(timeout).then(() => false)]);
  const stop = async pi => {
    if (pi.exited) return;
    if (closeFirst && await exitsWithin(pi, grace)) return;
    pi.kill('SIGTERM');
    if (await exitsWithin(pi, grace)) return;
    pi.kill('SIGKILL');
    // Let close reap the killed child before the parent exits.
    await exitsWithin(pi, grace);
  };
  await Promise.all(children.map(stop));
}
