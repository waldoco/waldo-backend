import {
  APP_PRIVACY_NOTICE_VERSION_V1, APP_TERMS_VERSION_V1, appConsentPurposeV1Schema, type AppConsentPurposeV1, type AppConsentStateV1,
} from '../../../contracts/src/app/onboarding';

type Sql = Pick<SqlStorage, 'exec'>;

// The copy each purpose is granted against. The look-up is disclosed in the privacy notice, so its consent names the notice
// version: a new notice asks again rather than carrying an old yes onto copy the owner never saw.
export const CURRENT_CONSENT_VERSION: Readonly<Record<AppConsentPurposeV1, number>> = {
  terms: APP_TERMS_VERSION_V1, privacy_notice: APP_PRIVACY_NOTICE_VERSION_V1, owner_lookup: APP_PRIVACY_NOTICE_VERSION_V1,
};
const AGE = 'age_18_plus';

type Row = Readonly<{ purpose: string; action: 'granted' | 'withdrawn'; version: number | null; at: number }>;
export type ConsentGrant = Readonly<{ state: AppConsentStateV1; changed: boolean }> | 'stale_version';

// The owner's consent ledger in the owner object, next to the data it governs, so a check and the write it guards can share
// one transaction. Rows are only ever appended: a withdrawal is a new row, and the current state is the newest row per purpose.
// terms and the notice end only with the account; the 18+ attestation is a row of its own.
export const consentLedger = (sql: Sql) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS consent_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn')),
    version INTEGER, at INTEGER NOT NULL)`);
  const latest = (purpose: string): Row | null =>
    sql.exec<Row>('SELECT purpose, action, version, at FROM consent_ledger WHERE purpose = ? ORDER BY id DESC LIMIT 1', purpose).toArray()[0] ?? null;
  const lastGrant = (purpose: string): Row | null =>
    sql.exec<Row>("SELECT purpose, action, version, at FROM consent_ledger WHERE purpose = ? AND action = 'granted' ORDER BY id DESC LIMIT 1", purpose).toArray()[0] ?? null;
  const state = (purpose: AppConsentPurposeV1): AppConsentStateV1 => {
    const row = latest(purpose);
    if (!row) return { purpose, version: null, status: 'not_granted', granted_at: null, withdrawn_at: null };
    if (row.action === 'granted') return { purpose, version: row.version, status: 'granted', granted_at: row.at, withdrawn_at: null };
    const granted = lastGrant(purpose)!;
    return { purpose, version: granted.version, status: 'withdrawn', granted_at: granted.at, withdrawn_at: row.at };
  };
  const ageAttested = () => latest(AGE)?.action === 'granted';
  const append = (purpose: string, action: Row['action'], version: number | null, at: number) =>
    sql.exec('INSERT INTO consent_ledger (purpose, action, version, at) VALUES (?, ?, ?, ?)', purpose, action, version, at);
  return {
    state,
    ageAttested,
    list: () => ({ age_attested_18_plus: ageAttested(), consents: appConsentPurposeV1Schema.options.map(state) }),
    // Live only for the copy that is current now.
    active: (purpose: AppConsentPurposeV1): boolean => { const current = state(purpose); return current.status === 'granted' && current.version === CURRENT_CONSENT_VERSION[purpose]; },
    attestAge(at: number): void { if (!ageAttested()) append(AGE, 'granted', 1, at); },
    // Granting what is already granted at this version changes nothing, so a repeated yes leaves one record.
    grant(purpose: AppConsentPurposeV1, version: number, at: number): ConsentGrant {
      if (version !== CURRENT_CONSENT_VERSION[purpose]) return 'stale_version';
      const current = state(purpose);
      if (current.status === 'granted' && current.version === version) return { state: current, changed: false };
      append(purpose, 'granted', version, at);
      return { state: state(purpose), changed: true };
    },
    withdraw(purpose: 'owner_lookup', at: number): Readonly<{ state: AppConsentStateV1; changed: boolean }> {
      if (state(purpose).status !== 'granted') return { state: state(purpose), changed: false };
      append(purpose, 'withdrawn', null, at);
      return { state: state(purpose), changed: true };
    },
  };
};
export type ConsentLedger = ReturnType<typeof consentLedger>;
