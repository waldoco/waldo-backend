// Identical pre-auth responses prevent code/device existence and infrastructure oracles.
export const genericReject = (): Response => new Response('{"error":"invalid_request"}', { status: 401, headers: { 'content-type': 'application/json' } });
export const deviceDiagnostic = (code: 'infrastructure_unavailable' | 'invalid_shape' | 'unknown_message' | 'idempotency_conflict' | 'version_mismatch'): void => {
  console.warn(JSON.stringify({ module: 'device_bridge', code }));
};
