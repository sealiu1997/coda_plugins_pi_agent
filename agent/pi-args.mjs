// Parse the extra Pi CLI arguments set in Coda. The main RPC process gets all of them;
// the isolated title process only needs explicit extensions so provider models resolve.
export function parsePiExtraArgs(value) {
  const args = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
  // Pi 1.1.0 accepts separated values; Coda also accepts equals forms.
  return args.flatMap(arg => arg.startsWith('--extension=') ? ['--extension', arg.slice('--extension='.length)]
    : arg.startsWith('-e=') ? ['-e', arg.slice(3)] : [arg]);
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
