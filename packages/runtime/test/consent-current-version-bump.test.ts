import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { appConsentListAtRevision, appConsentListV1Schema } from '../../contracts/src/app/onboarding';
import { consentLedger } from '../src/onboarding/consent-ledger';

// The privacy notice moved to its second copy: the list names it, an owner who accepted the first reads not active, and the
// first copy is refused.
vi.mock('../../contracts/src/app/onboarding', async (original) => ({ ...await original<typeof import('../../contracts/src/app/onboarding')>(), APP_PRIVACY_NOTICE_VERSION_V1: 2 }));

describe('after a privacy notice bump', () => {
  it('current_version follows the constant, and the yes given to the older copy no longer counts', () =>
    runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('consent-bump')), async (_instance, state) => {
      const ledger = consentLedger(state.storage.sql, { agreementsOffered: true, lookupOffered: true });
      // Accepted before the bump, at the first copy.
      state.storage.sql.exec("INSERT INTO consent_ledger (purpose, action, version, at) VALUES ('terms', 'granted', 1, 1000), ('privacy_notice', 'granted', 1, 1000)");
      const list = appConsentListV1Schema.parse(appConsentListAtRevision(ledger.list(), 3));
      expect(list.consents.map(row => [row.purpose, row.version, row.current_version, row.active])).toEqual([
        ['terms', 1, 1, true], ['privacy_notice', 1, 2, false], ['owner_lookup', null, 2, false],
      ]);
      expect(ledger.grant('privacy_notice', 1, 2000)).toBe('stale_version');
    }));
});
