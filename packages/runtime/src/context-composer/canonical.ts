import { FailClosed } from './faults';

// ECMAScript relational string comparison is a binary UTF-16 code-unit comparison. Naming it
// makes the ordering policy explicit and avoids host locale/ICU variation in prompt provenance.
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function stableJson(value: unknown): string {
  const visit = (current: unknown): string => {
    if (current === null) return 'null';
    if (typeof current === 'string') return JSON.stringify(current);
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new FailClosed('provenance_invalid');
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) return `[${current.map(visit).join(',')}]`;
    if (typeof current !== 'object' || Object.getPrototypeOf(current) !== Object.prototype) {
      throw new FailClosed('provenance_invalid');
    }
    const record = current as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${visit(record[key])}`)
      .join(',')}}`;
  };
  return visit(value);
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (item) => item.toString(16).padStart(2, '0')).join('');
}

export async function sha256Prefixed(value: string): Promise<string> {
  return `sha256:${await sha256Hex(value)}`;
}
