// Plain argv parsing shared by the backtest and paper CLIs. A flags
// library would be another dependency for the sake of one loop.

export function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args.set(token.slice(2), next);
      i += 1;
    } else {
      args.set(token.slice(2), 'true');
    }
  }
  return args;
}

export function numberArg(args: Map<string, string>, name: string, fallback: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`--${name} expects a number, got ${raw}`);
  return value;
}
