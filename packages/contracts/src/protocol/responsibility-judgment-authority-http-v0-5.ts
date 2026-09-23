export const responsibilityJudgmentAuthorityHttpMediaTypeV05 =
  'application/vnd.waldo.responsibility.v0.5+json' as const;

export const responsibilityJudgmentAuthorityHttpRouteManifestV05 = Object.freeze([
  Object.freeze({
    id: 'judgment_projection',
    method: 'GET',
    path: '/public/responsibilities/judgments/projection',
    protocolVersions: Object.freeze(['0.5'] as const),
  }),
  Object.freeze({
    id: 'judgment_answer',
    method: 'POST',
    path: '/public/responsibilities/judgments/answers',
    protocolVersions: Object.freeze(['0.5'] as const),
  }),
] as const);

export type ResponsibilityJudgmentAuthorityHttpRouteV05 =
  (typeof responsibilityJudgmentAuthorityHttpRouteManifestV05)[number];

export function matchResponsibilityJudgmentAuthorityHttpRouteV05(
  method: string,
  path: string,
): ResponsibilityJudgmentAuthorityHttpRouteV05 | null {
  return responsibilityJudgmentAuthorityHttpRouteManifestV05.find(
    (route) => route.method === method && route.path === path,
  ) ?? null;
}
