import { describe, expect, it } from 'vitest';
import {
  matchResponsibilityJudgmentAuthorityHttpRouteV05,
  responsibilityJudgmentAuthorityHttpMediaTypeV05,
  responsibilityJudgmentAuthorityHttpRouteManifestV05,
} from './responsibility-judgment-authority-http-v0-5';

describe('public Judgment Authority HTTP v0.5 contract', () => {
  it('publishes only the owner-bound projection and answer routes', () => {
    expect(responsibilityJudgmentAuthorityHttpMediaTypeV05).toBe(
      'application/vnd.waldo.responsibility.v0.5+json',
    );
    expect(responsibilityJudgmentAuthorityHttpRouteManifestV05).toEqual([
      {
        id: 'judgment_projection',
        method: 'GET',
        path: '/public/responsibilities/judgments/projection',
        protocolVersions: ['0.5'],
      },
      {
        id: 'judgment_answer',
        method: 'POST',
        path: '/public/responsibilities/judgments/answers',
        protocolVersions: ['0.5'],
      },
    ]);
    for (const route of responsibilityJudgmentAuthorityHttpRouteManifestV05) {
      expect(matchResponsibilityJudgmentAuthorityHttpRouteV05(route.method, route.path))
        .toEqual(route);
    }
    expect(matchResponsibilityJudgmentAuthorityHttpRouteV05(
      'POST',
      '/public/responsibilities/judgments',
    )).toBeNull();
  });
});
