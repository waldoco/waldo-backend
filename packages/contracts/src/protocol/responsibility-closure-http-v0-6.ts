export const responsibilityClosureHttpMediaTypeV06 =
  'application/vnd.waldo.responsibility.v0.6+json' as const;

export const responsibilityClosureHttpRouteManifestV06 = Object.freeze([
  Object.freeze({
    id: 'closure_acceptance_check_declare',
    method: 'POST',
    path: '/public/responsibilities/closure/acceptance-checks',
    protocolVersions: Object.freeze(['0.6'] as const),
  }),
  Object.freeze({
    id: 'closure_evidence_admit',
    method: 'POST',
    path: '/public/responsibilities/closure/evidence',
    protocolVersions: Object.freeze(['0.6'] as const),
  }),
  Object.freeze({
    id: 'closure_verification_request',
    method: 'POST',
    path: '/public/responsibilities/closure/verifications',
    protocolVersions: Object.freeze(['0.6'] as const),
  }),
  Object.freeze({
    id: 'closure_acceptance_record',
    method: 'POST',
    path: '/public/responsibilities/closure/acceptances',
    protocolVersions: Object.freeze(['0.6'] as const),
  }),
  Object.freeze({
    id: 'closure_projection',
    method: 'GET',
    path: '/public/responsibilities/closure/projection',
    protocolVersions: Object.freeze(['0.6'] as const),
  }),
] as const);

export type ResponsibilityClosureHttpRouteV06 =
  (typeof responsibilityClosureHttpRouteManifestV06)[number];

export function matchResponsibilityClosureHttpRouteV06(
  method: string,
  path: string,
): ResponsibilityClosureHttpRouteV06 | null {
  return responsibilityClosureHttpRouteManifestV06.find(
    (route) => route.method === method && route.path === path,
  ) ?? null;
}
