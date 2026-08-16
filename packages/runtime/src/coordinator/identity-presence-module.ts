import { RESPONSIBILITY_OWNER_ROOT_ROUTING_VERSION } from '../responsibility/constants';
import {
  ResponsibilityAuthorityDeniedError,
  ResponsibilityOwnerRootMismatchError,
} from '../responsibility/errors';

export type OwnerRoot = Readonly<{ ownerId: string }>;

export type ResponsibilityCanonicalAuthority = Readonly<{
  ownerId: string;
  authenticatedSubjectRef: string;
  presenceId: string;
  presenceRegistrationId: string;
  authenticatedSessionId: string;
  ownerPolicyRevision: number;
  ownerRootRoutingVersion: number;
}>;

export type ResponsibilityCanonicalAuthorityWithAssurance =
  ResponsibilityCanonicalAuthority & Readonly<{ authAssurance: string }>;

export type ResponsibilityCanonicalAuthorityRegistration =
  ResponsibilityCanonicalAuthority & Readonly<{
    authAssurance?: string;
    authenticatedSessionExpiresAt: string;
    presenceState: 'active';
    at: string;
  }>;

type OwnerRootRow = {
  owner_id: string;
  authenticated_subject_ref: string | null;
  state: string | null;
  owner_policy_revision: number | null;
  owner_root_routing_version: number | null;
};

type CanonicalAuthorityRow = OwnerRootRow & {
  presence_registration_id: string;
  presence_id: string;
  presence_state: string;
  authenticated_session_id: string;
  session_expires_at: string;
  auth_assurance: string;
};

const MAX_ACTIVE_SESSIONS_PER_PRESENCE = 16;

/** Sole writer and resolver for owner identity and Presence authority in this owner DO. */
export class IdentityPresenceModule {
  constructor(private readonly storage: DurableObjectStorage) {}

  bootstrapOrRefreshCanonicalAuthorityInCurrentTransaction(
    registration: ResponsibilityCanonicalAuthorityRegistration,
  ): ResponsibilityCanonicalAuthorityWithAssurance {
    assertRegistration(registration);
    const authAssurance = registration.authAssurance ?? 'legacy_unverified';
    const existingRoot = this.readRoot();
    if (existingRoot === undefined) {
      this.storage.sql.exec(
        `INSERT INTO owner_roots (
          root_key, owner_id, created_at, authenticated_subject_ref, state,
          owner_policy_revision, owner_root_routing_version, updated_at
        ) VALUES (1, ?, ?, ?, 'active', ?, ?, ?)`,
        registration.ownerId,
        registration.at,
        registration.authenticatedSubjectRef,
        registration.ownerPolicyRevision,
        registration.ownerRootRoutingVersion,
        registration.at,
      );
    } else if (
      existingRoot.owner_id === registration.ownerId &&
      existingRoot.authenticated_subject_ref === null &&
      existingRoot.state === null &&
      existingRoot.owner_policy_revision === null &&
      existingRoot.owner_root_routing_version === null
    ) {
      this.storage.sql.exec(
        `UPDATE owner_roots
            SET authenticated_subject_ref = ?, state = 'active',
                owner_policy_revision = ?, owner_root_routing_version = ?, updated_at = ?
          WHERE root_key = 1`,
        registration.authenticatedSubjectRef,
        registration.ownerPolicyRevision,
        registration.ownerRootRoutingVersion,
        registration.at,
      );
    } else if (
      existingRoot.owner_id !== registration.ownerId ||
      existingRoot.authenticated_subject_ref !== registration.authenticatedSubjectRef ||
      existingRoot.state !== 'active' ||
      existingRoot.owner_policy_revision !== registration.ownerPolicyRevision ||
      existingRoot.owner_root_routing_version !== registration.ownerRootRoutingVersion
    ) {
      throw new ResponsibilityAuthorityDeniedError();
    }

    const existingPresence = this.readPresenceRegistration(
      registration.presenceRegistrationId,
    );
    if (existingPresence === undefined) {
      const existingOwnerPresence = this.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM presence_registrations WHERE owner_id = ?',
        registration.ownerId,
      ).one().count;
      if (existingOwnerPresence !== 0) {
        throw new ResponsibilityAuthorityDeniedError();
      }
      this.storage.sql.exec(
        `INSERT INTO presence_registrations (
          presence_registration_id, owner_id, presence_id, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        registration.presenceRegistrationId,
        registration.ownerId,
        registration.presenceId,
        registration.presenceState,
        registration.at,
        registration.at,
      );
    } else if (
      existingPresence.owner_id !== registration.ownerId ||
      existingPresence.presence_id !== registration.presenceId ||
      existingPresence.presence_state !== 'active'
    ) {
      throw new ResponsibilityAuthorityDeniedError();
    }

    this.storage.sql.exec(
      `DELETE FROM presence_sessions
        WHERE presence_registration_id = ? AND expires_at <= ?`,
      registration.presenceRegistrationId,
      registration.at,
    );
    const existingSession = this.storage.sql.exec<{
      presence_registration_id: string;
    }>(
      `SELECT presence_registration_id FROM presence_sessions
        WHERE authenticated_session_id = ?`,
      registration.authenticatedSessionId,
    ).toArray()[0];
    if (existingSession === undefined) {
      const activeSessionCount = this.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM presence_sessions
          WHERE presence_registration_id = ?`,
        registration.presenceRegistrationId,
      ).one().count;
      if (activeSessionCount >= MAX_ACTIVE_SESSIONS_PER_PRESENCE) {
        throw new ResponsibilityAuthorityDeniedError();
      }
      this.storage.sql.exec(
        `INSERT INTO presence_sessions (
          authenticated_session_id, presence_registration_id,
          expires_at, created_at, last_seen_at, auth_assurance
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        registration.authenticatedSessionId,
        registration.presenceRegistrationId,
        registration.authenticatedSessionExpiresAt,
        registration.at,
        registration.at,
        authAssurance,
      );
    } else if (existingSession.presence_registration_id !== registration.presenceRegistrationId) {
      throw new ResponsibilityAuthorityDeniedError();
    } else {
      this.storage.sql.exec(
        `UPDATE presence_sessions
            SET expires_at = ?, last_seen_at = ?, auth_assurance = ?
          WHERE authenticated_session_id = ?`,
        registration.authenticatedSessionExpiresAt,
        registration.at,
        authAssurance,
        registration.authenticatedSessionId,
      );
    }
    return freezeAuthority(registration, authAssurance);
  }

  assertCanonicalAuthorityInCurrentTransaction(
    claim: ResponsibilityCanonicalAuthority,
    at: string,
  ): ResponsibilityCanonicalAuthorityWithAssurance {
    const row = this.readCanonicalAuthority(
      claim.presenceRegistrationId,
      claim.authenticatedSessionId,
    );
    const atMillis = Date.parse(at);
    const sessionExpiresAt = Date.parse(row?.session_expires_at ?? '');
    if (
      !Number.isFinite(atMillis) || row === undefined ||
      !Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= atMillis ||
      row.owner_id !== claim.ownerId ||
      row.authenticated_subject_ref !== claim.authenticatedSubjectRef ||
      row.presence_id !== claim.presenceId ||
      row.authenticated_session_id !== claim.authenticatedSessionId ||
      row.owner_policy_revision !== claim.ownerPolicyRevision ||
      row.owner_root_routing_version !== claim.ownerRootRoutingVersion ||
      ('authAssurance' in claim && row.auth_assurance !== claim.authAssurance) ||
      row.state !== 'active' || row.presence_state !== 'active'
    ) {
      throw new ResponsibilityAuthorityDeniedError();
    }
    return freezeAuthority(claim, row.auth_assurance);
  }

  setPresenceStateInCurrentTransaction(
    presenceRegistrationId: string,
    state: 'active' | 'suspended' | 'revoked',
    at: string,
  ): void {
    if (!isProtocolId(presenceRegistrationId) || !Number.isFinite(Date.parse(at))) {
      throw new Error('invalid Presence lifecycle command');
    }
    const existing = this.readPresenceRegistration(presenceRegistrationId);
    if (existing === undefined) throw new ResponsibilityAuthorityDeniedError();
    this.storage.sql.exec(
      `UPDATE presence_registrations SET state = ?, updated_at = ?
        WHERE presence_registration_id = ?`,
      state,
      at,
      presenceRegistrationId,
    );
  }

  bindOrAssertOwnerRootInCurrentTransaction(ownerId: string, at: string): OwnerRoot {
    const existing = this.readRoot();
    if (existing !== undefined) {
      if (existing.owner_id !== ownerId) throw new ResponsibilityOwnerRootMismatchError();
      return Object.freeze({ ownerId });
    }
    this.storage.sql.exec(
      `INSERT INTO owner_roots (
        root_key, owner_id, created_at, authenticated_subject_ref, state,
        owner_policy_revision, owner_root_routing_version, updated_at
      ) VALUES (1, ?, ?, ?, 'active', 0, ?, ?)`,
      ownerId,
      at,
      `local-test:${ownerId}`,
      RESPONSIBILITY_OWNER_ROOT_ROUTING_VERSION,
      at,
    );
    return Object.freeze({ ownerId });
  }

  assertOwnerRoot(ownerId: string): OwnerRoot {
    const existing = this.readRoot();
    if (existing === undefined || existing.owner_id !== ownerId) {
      throw new ResponsibilityOwnerRootMismatchError();
    }
    return Object.freeze({ ownerId });
  }

  private readRoot(): OwnerRootRow | undefined {
    return this.storage.sql.exec<OwnerRootRow>(
      `SELECT owner_id, authenticated_subject_ref, state,
              owner_policy_revision, owner_root_routing_version
         FROM owner_roots WHERE root_key = 1`,
    ).toArray()[0];
  }

  private readPresenceRegistration(presenceRegistrationId: string): {
    owner_id: string;
    presence_id: string;
    presence_state: string;
  } | undefined {
    return this.storage.sql.exec<{
      owner_id: string;
      presence_id: string;
      presence_state: string;
    }>(
      `SELECT owner_id, presence_id, state AS presence_state
         FROM presence_registrations WHERE presence_registration_id = ?`,
      presenceRegistrationId,
    ).toArray()[0];
  }

  private readCanonicalAuthority(
    presenceRegistrationId: string,
    authenticatedSessionId: string,
  ): CanonicalAuthorityRow | undefined {
    return this.storage.sql.exec<CanonicalAuthorityRow>(
      `SELECT roots.owner_id, roots.authenticated_subject_ref, roots.state,
              roots.owner_policy_revision, roots.owner_root_routing_version,
              presence.presence_registration_id, presence.presence_id,
              presence.state AS presence_state,
              sessions.authenticated_session_id,
              sessions.expires_at AS session_expires_at,
              sessions.auth_assurance
         FROM owner_roots AS roots
         JOIN presence_registrations AS presence ON presence.owner_id = roots.owner_id
         JOIN presence_sessions AS sessions
           ON sessions.presence_registration_id = presence.presence_registration_id
        WHERE roots.root_key = 1 AND presence.presence_registration_id = ?
          AND sessions.authenticated_session_id = ?`,
      presenceRegistrationId,
      authenticatedSessionId,
    ).toArray()[0];
  }
}

function assertRegistration(registration: ResponsibilityCanonicalAuthorityRegistration): void {
  const at = Date.parse(registration.at);
  const expiresAt = Date.parse(registration.authenticatedSessionExpiresAt);
  if (
    !isProtocolId(registration.ownerId) ||
    !/^supabase_subject_[a-f0-9]{64}$/.test(registration.authenticatedSubjectRef) ||
    !isProtocolId(registration.presenceId) ||
    !isProtocolId(registration.presenceRegistrationId) ||
    !/^authenticated_session_[a-f0-9]{64}$/.test(registration.authenticatedSessionId) ||
    !Number.isSafeInteger(registration.ownerPolicyRevision) ||
    registration.ownerPolicyRevision < 0 ||
    registration.ownerRootRoutingVersion !== RESPONSIBILITY_OWNER_ROOT_ROUTING_VERSION ||
    registration.presenceState !== 'active' ||
    (registration.authAssurance !== undefined && !isProtocolId(registration.authAssurance)) ||
    !Number.isFinite(at) || !Number.isFinite(expiresAt) || expiresAt <= at
  ) {
    throw new Error('invalid responsibility authority registration');
  }
}

function freezeAuthority(
  value: ResponsibilityCanonicalAuthority,
  authAssurance: string,
): ResponsibilityCanonicalAuthorityWithAssurance {
  return Object.freeze({
    ownerId: value.ownerId,
    authenticatedSubjectRef: value.authenticatedSubjectRef,
    presenceId: value.presenceId,
    presenceRegistrationId: value.presenceRegistrationId,
    authenticatedSessionId: value.authenticatedSessionId,
    ownerPolicyRevision: value.ownerPolicyRevision,
    ownerRootRoutingVersion: value.ownerRootRoutingVersion,
    authAssurance,
  });
}

function isProtocolId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}
