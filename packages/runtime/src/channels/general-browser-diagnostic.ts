import { browserBoundedJson } from './browser-bounded-body';

export type GeneralBrowserDiagnostic = Readonly<{ status: number; code?: string; request_id?: string }>;
export async function generalBrowserDiagnostic(response: Response): Promise<GeneralBrowserDiagnostic> {
  // Only bounded protocol identifiers survive; provider prose is untrusted.
  const token = (raw: unknown): string | undefined => {
    const value = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : raw;
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : undefined;
  };
  let code: string | undefined;
  try {
    const body = await browserBoundedJson(response) as { code?: unknown; error?: { code?: unknown }; errors?: { code?: unknown }[] };
    code = token(body?.code) ?? token(body?.error?.code) ?? token(body?.errors?.[0]?.code);
  } catch { /* unknown/oversize bodies do not enter diagnostics */ }
  const request_id = token(response.headers.get('x-request-id')) ?? token(response.headers.get('cf-ray'));
  return { status: response.status, ...(code ? { code } : {}), ...(request_id ? { request_id } : {}) };
}
