// Stopping child processes: TERM first, then KILL when the grace runs out. A closed stdin
// gets the grace before TERM so a main Pi can flush and leave on its own. Each exit is
// awaited before the ACP process leaves, so no child outlives it.
export async function stopChildren(children, { grace = 500, closeFirst = false } = {}) {
  children = children.filter(pi => pi && !pi.exited);
  if (closeFirst) for (const pi of children) pi.close?.();
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

// Stop every child currently active and keep draining until no new child appears. A title
// child can finish spawning just after shutdown begins; stopping it from this shared source
// closes the snapshot gap between checking titleState and spawn completing.
export async function stopActiveChildren(activeChildren, options = {}) {
  const stopped = new Set();
  let quiet = 0;
  for (;;) {
    const pending = [...activeChildren()].filter(child => !child.exited && !stopped.has(child));
    if (pending.length === 0) {
      // Promise continuations are microtasks; one extra task turn gives a title spawn that
      // completed its synchronous call a chance to register before we declare the source empty.
      if (++quiet > 1) return;
      await new Promise(resolve => setImmediate(resolve));
      continue;
    }
    quiet = 0;
    for (const child of pending) stopped.add(child);
    await stopChildren(pending, options);
  }
}
