// Validate before SDK/runtime header construction. Never include credential content
// (literal or encoded) in errors. Do not normalize or silently strip pasted bytes.
export const validModelCredential = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9_.-]+$/.test(value);
