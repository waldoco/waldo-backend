import { describe, expect, it } from 'vitest';
import {
  matchResponsibilityClosureHttpRouteV06,
  responsibilityClosureHttpMediaTypeV06,
  responsibilityClosureHttpRouteManifestV06,
} from './responsibility-closure-http-v0-6';

describe('responsibility closure HTTP v0.6', () => {
  it('publishes exactly the five authenticated closure operations under a distinct media type', () => {
    expect(responsibilityClosureHttpMediaTypeV06).toBe(
      'application/vnd.waldo.responsibility.v0.6+json',
    );
    expect(responsibilityClosureHttpRouteManifestV06.map(({ id, method, path }) => ({
      id,
      method,
      path,
    }))).toEqual([
      { id: 'closure_acceptance_check_declare', method: 'POST', path: '/public/responsibilities/closure/acceptance-checks' },
      { id: 'closure_evidence_admit', method: 'POST', path: '/public/responsibilities/closure/evidence' },
      { id: 'closure_verification_request', method: 'POST', path: '/public/responsibilities/closure/verifications' },
      { id: 'closure_acceptance_record', method: 'POST', path: '/public/responsibilities/closure/acceptances' },
      { id: 'closure_projection', method: 'GET', path: '/public/responsibilities/closure/projection' },
    ]);
    for (const route of responsibilityClosureHttpRouteManifestV06) {
      expect(matchResponsibilityClosureHttpRouteV06(route.method, route.path)).toBe(route);
    }
    expect(matchResponsibilityClosureHttpRouteV06('POST', '/public/responsibilities/closure')).toBeNull();
  });
});
