// Parse the extra Pi CLI arguments set in Coda. The main RPC process gets all of them;
// the isolated title process only needs explicit extensions so provider models resolve.
export function parsePiExtraArgs(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  return [];
}

export function extensionPathsFromArgs(args) {
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--extension' || arg === '-e') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) paths.push(args[++i]);
    } else if (arg.startsWith('--extension=')) {
      const path = arg.slice('--extension='.length);
      if (path) paths.push(path);
    } else if (arg.startsWith('-e=')) {
      const path = arg.slice(3);
      if (path) paths.push(path);
    }
  }
  return paths;
}
