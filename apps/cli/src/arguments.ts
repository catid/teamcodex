export function argValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || null : null;
}
