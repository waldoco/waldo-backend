import { signedRpc, type OwnerDirectoryEnv } from './owner-directory';

// The words an owner agrees to. Signup and the console both show this text, and an agreement counts only for the version
// it was given to: new wording means a new version, and every earlier agreement stops counting until the owner agrees again.
export const DIAGNOSTIC_RECORDING_WORDING = Object.freeze({
  version: 'beta-2026-10-25',
  label: 'During the beta, let the Waldo team read my chats with Waldo to find and fix problems (optional)',
  detail: 'If you agree, Waldo records the full text of your conversations with it: your messages, Waldo’s replies, what its '
    + 'tools returned and any health information in them, with your email address. The records go to Langfuse, the diagnostic '
    + 'service we use; error details and your email address also go to our service logs. The Ecofresh team members who work on '
    + 'Waldo can read them. Diagnostic records are kept for 30 days, and service logs for up to 7 days. You can turn this off at '
    + 'any time in the app, or in the console under Settings, Your day; recording stops from your next message, and your earlier '
    + 'diagnostic records are deleted within 7 days. To ask about your records, write to woof@heywaldo.in. Waldo works the same '
    + 'whether or not you agree.',
});

export type DiagnosticAgreement = Readonly<{ agreed: boolean; version: string | null }>;
export type DiagnosticRecordingSource = 'signup' | 'console' | 'app';
export type DiagnosticRecordingDirectory = Readonly<{
  /** The owner's live agreement; null when the directory has no active owner for this DO. Throws when unreachable. */
  read(doName: string): Promise<DiagnosticAgreement | null>;
  /** True once the directory recorded the change; false when it refused it. Throws when unreachable. */
  set(doName: string, agreed: boolean, source: DiagnosticRecordingSource): Promise<boolean>;
}>;

const readAgreement = (value: unknown): DiagnosticAgreement | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.agreed !== 'boolean') return null;
  return { agreed: row.agreed, version: typeof row.version === 'string' ? row.version : null };
};

export const diagnosticRecordingDirectory = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): DiagnosticRecordingDirectory | null => {
  const rpc = signedRpc(env, fetcher, now);
  if (!rpc) return null;
  return {
    read: async (doName) => readAgreement(await rpc('diagnostic_recording_state', `diagnostic.read.${doName}`, { p_do_name: doName })),
    set: async (doName, agreed, source) => {
      const version = DIAGNOSTIC_RECORDING_WORDING.version;
      return (await rpc('set_diagnostic_recording', `diagnostic.set.${doName}.${agreed ? 'on' : 'off'}.${version}.${source}`,
        { p_do_name: doName, p_agreed: agreed, p_version: version, p_source: source })) === true;
    },
  };
};

// A turn waits on this read, so it is bounded well under the directory's general request timeout.
export const DIAGNOSTIC_READ_TIMEOUT_MS = 2_000;

// Whether the owner agreed to the current wording, as the directory answers it now. Every failure (no directory, no DO
// name, an unreachable or slow directory, a malformed answer, an older wording) answers not agreed.
export const readDiagnosticAgreement = async (directory: DiagnosticRecordingDirectory | null, doName: string | undefined): Promise<boolean> => {
  if (!directory || !doName) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const agreement = await Promise.race([
      directory.read(doName),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), DIAGNOSTIC_READ_TIMEOUT_MS); }),
    ]);
    return agreement?.agreed === true && agreement.version === DIAGNOSTIC_RECORDING_WORDING.version;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};
