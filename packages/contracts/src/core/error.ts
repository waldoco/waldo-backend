import { z } from 'zod';

// Branded so an ISO-8601 timestamp can't be passed where a plain string is expected.
// z.iso.datetime is Zod 4's ISO validator; offset:true also admits +HH:MM, not only 'Z'.
export const iso8601Schema = z.iso.datetime({ offset: true }).brand<'ISO8601'>();
export type ISO8601 = z.infer<typeof iso8601Schema>;

export const errorCodeSchema = z.enum([
  'auth_failed',
  'not_found',
  'forbidden',
  'rate_limited',
  'transient',
  'oversize',
  'invalid_args',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// Uniform return of every adapter method. A generic discriminated union kept as a static
// type, not a Zod schema: a generic Zod schema would be a factory function, not a value,
// and the contract callers depend on is the shape, not a runtime validator.
export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: ErrorCode };
