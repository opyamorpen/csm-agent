import { createHash } from 'node:crypto';

/** Stable JSON encoding used to bind a human approval to exact tool arguments. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function argumentsHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(stableJson(args)).digest('hex');
}
