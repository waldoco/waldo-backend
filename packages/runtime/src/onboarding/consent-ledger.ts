import {
  APP_PRIVACY_NOTICE_VERSION_V1, APP_TERMS_VERSION_V1, appConsentPurposeV1Schema, type AppConsentPurposeV1, type AppConsentStateV1,
} from '../../../contracts/src/app/onboarding';

type Sql = Pick<SqlStorage, 'exec'>;

// The copy each purpose is granted against. The look-up is disclosed in the privacy notice, so its consent names the notice
// version: a new notice asks again rather than carrying an old yes onto copy the owner never saw.
export const CURRENT_CONSENT_VERSION: Readonly<Record<AppConsentPurposeV1, number>> = {
  terms: APP_TERMS_VERSION_V1, privacy_notice: APP_PRIVACY_NOTICE_VERSION_V1, owner_lookup: APP_PRIVACY_NOTICE_VERSION_V1,
};
// A purpose whose disclosure lives in another accepted copy: it can be granted, and counts, only while that copy is accepted.
const DEPENDS_ON: Readonly<Partial<Record<AppConsentPurposeV1, AppConsentPurposeV1>>> = { owner_lookup: 'privacy_notice' };
const AGE = 'age_18_plus';
// The only purposes this ledger can hold. The table refuses any other, so a health purpose cannot reach it by any code path:
// health consent has one representation, in the health plane, per source and purpose.
const LEDGER_PURPOSES = [...appConsentPurposeV1Schema.options, AGE].map(purpose => `'${purpose}'`).join(', ');

type Row = Readonly<{ purpose: string; action: 'granted' | 'withdrawn'; version: number | null; at: number }>;
export type ConsentGrant = Readonly<{ state: AppConsentStateV1; changed: boolean }> | 'stale_version' | 'notice_required' | 'not_offered';
// The server's switches, each off until the owner approves the copy it rests on: agreementsOffered for the terms and the notice,
// lookupOffered for the look-up the notice discloses. Off, a purpose cannot be granted and a yes recorded earlier does not
// count; the rows stay as evidence. The look-up rests on the notice, so it is offered only while the agreements are too.
export type ConsentOptions = Readonly<{ agreementsOffered: boolean; lookupOffered: boolean }>;
// The one reading of the Worker's APP_AGREEMENTS and OWNER_LOOKUP: only "1" turns either on.
export const consentSwitches = (env: Readonly<{ APP_AGREEMENTS?: string; OWNER_LOOKUP?: string }>): ConsentOptions =>
  ({ agreementsOffered: env.APP_AGREEMENTS === '1', lookupOffered: env.OWNER_LOOKUP === '1' });

// The owner's consent ledger in the owner object, next to the data it governs, so a check and the write it guards can share
// one transaction. Rows are only ever appended: a withdrawal is a new row, and the current state is the newest row per purpose.
// terms and the notice end only with the account; the 18+ attestation is a row of its own.
export const consentLedger = (sql: Sql, options: ConsentOptions) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS consent_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT NOT NULL CHECK (purpose IN (${LEDGER_PURPOSES})), action TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn')),
    version INTEGER, at INTEGER NOT NULL)`);
  const latest = (purpose: string): Row | null =>
    sql.exec<Row>('SELECT purpose, action, version, at FROM consent_ledger WHERE purpose = ? ORDER BY id DESC LIMIT 1', purpose).toArray()[0] ?? null;
  const lastGrant = (purpose: string): Row | null =>
    sql.exec<Row>("SELECT purpose, action, version, at FROM consent_ledger WHERE purpose = ? AND action = 'granted' ORDER BY id DESC LIMIT 1", purpose).toArray()[0] ?? null;
  const recorded = (purpose: AppConsentPurposeV1): Omit<AppConsentStateV1, 'active'> => {
    const row = latest(purpose);
    if (!row) return { purpose, version: null, status: 'not_granted', granted_at: null, withdrawn_at: null };
    if (row.action === 'granted') return { purpose, version: row.version, status: 'granted', granted_at: row.at, withdrawn_at: null };
    const granted = lastGrant(purpose)!;
    return { purpose, version: granted.version, status: 'withdrawn', granted_at: granted.at, withdrawn_at: row.at };
  };
  const offered = (purpose: AppConsentPurposeV1) => options.agreementsOffered && (purpose !== 'owner_lookup' || options.lookupOffered);
  // Live only for the copy that is current now, while the server offers it and the copy it depends on is live too.
  const active = (purpose: AppConsentPurposeV1): boolean => {
    const current = recorded(purpose), prerequisite = DEPENDS_ON[purpose];
    return offered(purpose) && current.status === 'granted' && current.version === CURRENT_CONSENT_VERSION[purpose] && (prerequisite === undefined || active(prerequisite));
  };
  const state = (purpose: AppConsentPurposeV1): AppConsentStateV1 => ({ ...recorded(purpose), active: active(purpose) });
  const ageAttested = () => latest(AGE)?.action === 'granted';
  const append = (purpose: string, action: Row['action'], version: number | null, at: number) =>
    sql.exec('INSERT INTO consent_ledger (purpose, action, version, at) VALUES (?, ?, ?, ?)', purpose, action, version, at);
  return {
    state,
    ageAttested,
    offered,
    active,
    // The terms and the notice, both at their current copy: what every step after the agreements needs.
    agreed: (): boolean => active('terms') && active('privacy_notice'),
    // Whether the steps after the agreements may run: once this server offers the agreements, only with them accepted at their
    // current copy. While it holds them back the steps run and the agreements step stays pending; the look-up stays refused.
    stepsOpen: (): boolean => !offered('terms') || (active('terms') && active('privacy_notice')),
    list: () => ({ age_attested_18_plus: ageAttested(), agreements_offered: offered('terms'), owner_lookup_offered: offered('owner_lookup'), consents: appConsentPurposeV1Schema.options.map(state) }),
    attestAge(at: number): void { if (!ageAttested()) append(AGE, 'granted', 1, at); },
    // Granting what is already granted at this version changes nothing, so a repeated yes leaves one record.
    grant(purpose: AppConsentPurposeV1, version: number, at: number): ConsentGrant {
      if (version !== CURRENT_CONSENT_VERSION[purpose]) return 'stale_version';
      if (!offered(purpose)) return 'not_offered';
      const prerequisite = DEPENDS_ON[purpose];
      if (prerequisite !== undefined && !active(prerequisite)) return 'notice_required';
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
