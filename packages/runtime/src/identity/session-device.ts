import { APP_SESSION_LABEL_MAX_V1, type AppSessionDeviceV1 } from '../../../contracts/src/app/core';
import { linkCodeHash } from './owner-directory';

// The app's route for its own session's device, and the owner object's internal route the Worker writes through.
export const APP_SESSION_DEVICE_PATH = '/app/v1/session/device';
export const SESSION_DEVICE_PATH = '/session-device';

// What device holds one directory session, for the owner's list of where they are signed in. It is account metadata,
// kept in the owner object (erased with it) under the session's hash, never the device's own name or the raw User-Agent.
export type SessionDevice = Readonly<{ kind: 'phone' | 'tablet' | 'computer' | 'unknown'; label: string }>;
type Kv = Pick<SyncKvStorage, 'get' | 'put' | 'delete' | 'list'>;
const PREFIX = 'session_device:';
const SESSION_HASH = /^[a-f0-9]{64}$/;

// Control, format (bidi overrides, zero-width), lone surrogate and line or paragraph separators never reach a label.
const printable = (value: string) => value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/gu, ' ').trim();

// "iPhone 17 Pro · iOS 26": the model the platform reports and the OS's major version. null when nothing printable is left.
export const appSessionDevice = (device: AppSessionDeviceV1): (SessionDevice & { kind: 'phone' | 'tablet' }) | null => {
  const model = printable(device.model);
  if (!model) return null;
  const kind = device.kind ?? 'phone';
  const system = device.platform === 'android' ? 'Android' : kind === 'tablet' ? 'iPadOS' : 'iOS';
  return { kind, label: `${model} · ${system} ${device.os_version.split('.')[0]}` };
};

// Order matters: each browser's User-Agent also names the engines it descends from (Edge says Chrome and Safari; Chrome
// says Safari), and iOS says "like Mac OS X", Android says Linux.
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'], [/\bOPR\/|\bOpera\b/, 'Opera'], [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'], [/\bChrome\/|\bCriOS\//, 'Chrome'], [/\bVersion\/[0-9.]+ .*\bSafari\//, 'Safari'],
];
const SYSTEMS: readonly (readonly [RegExp, string, SessionDevice['kind']])[] = [
  [/\biPhone\b|\biPod\b/, 'iOS', 'phone'], [/\biPad\b/, 'iPadOS', 'tablet'], [/\bAndroid\b.*\bMobile\b/, 'Android', 'phone'],
  [/\bAndroid\b/, 'Android', 'tablet'], [/\bCrOS\b/, 'ChromeOS', 'computer'], [/\bWindows NT\b/, 'Windows', 'computer'],
  [/\bMacintosh\b|\bMac OS X\b/, 'macOS', 'computer'], [/\bLinux\b/, 'Linux', 'computer'],
];
// A coarse "Chrome on macOS" from a web sign-in's User-Agent. Only the browser family and system are kept, never
// versions or the string itself. null when neither is recognised. iPadOS Safari presents as macOS and reads as a computer.
export const browserSessionDevice = (userAgent: string | null): SessionDevice | null => {
  const agent = (userAgent ?? '').slice(0, 512);
  const browser = BROWSERS.find(([pattern]) => pattern.test(agent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(agent));
  if (!system) return browser ? { kind: 'unknown', label: browser } : null;
  return { kind: system[2], label: `${browser ?? 'Browser'} on ${system[1]}` };
};

type Stored = SessionDevice & Readonly<{ at: number }>;
const PRUNE_GRACE_MS = 10 * 60_000;
export const sessionDevices = (kv: Kv, now: () => number = Date.now) => {
  const stored = (hash: string) => kv.get<Stored>(`${PREFIX}${hash}`);
  const write = (hash: string, device: SessionDevice) => { if (SESSION_HASH.test(hash)) kv.put(`${PREFIX}${hash}`, { kind: device.kind, label: device.label, at: now() } satisfies Stored); };
  return {
    read(hash: string): SessionDevice | null { const device = stored(hash); return device ? { kind: device.kind, label: device.label } : null; },
    record: write,
    // A renewal opens a new session for the same device: it keeps the device's description.
    carry(from: string, to: string): void { const device = stored(from); if (device) write(to, device); },
    // Descriptions of sessions the directory no longer lists are dropped when the list is read. A description younger than
    // the grace may belong to a session opened after that list was read, so it waits for a later read.
    keepOnly(live: ReadonlySet<string>): void {
      for (const [key, device] of kv.list<Stored>({ prefix: PREFIX })) if (!live.has(key.slice(PREFIX.length)) && !(now() - (device?.at ?? 0) < PRUNE_GRACE_MS)) kv.delete(key);
    },
  };
};

// The session hash inside a minted credential or owner cookie (`<do name>.<session id>.<signature>`).
export const credentialSessionHash = async (value: string): Promise<string | null> => {
  const sigDot = value.lastIndexOf('.'), sessionDot = sigDot > 0 ? value.lastIndexOf('.', sigDot - 1) : -1;
  return sessionDot > 0 ? linkCodeHash(value.slice(sessionDot + 1, sigDot)) : null;
};

const NOTE_TIMEOUT_MS = 3_000;
export type SessionDeviceNote = Readonly<{ session: string; device: SessionDevice } | { session: string; from: string }>;
// Records a web sign-in's device, or carries a renewed session's, in the owner object. Best effort: a sign-in or renewal
// never fails over its description, which only costs the owner a named row.
export const noteSessionDevice = async (owners: DurableObjectNamespace | undefined, doName: string, note: SessionDeviceNote): Promise<void> => {
  try {
    const answer = await owners?.get(owners.idFromName(doName)).fetch(new Request(`https://telegram-owner${SESSION_DEVICE_PATH}`, {
      method: 'POST', headers: { 'x-waldo-do-name': doName, 'content-type': 'application/json' }, body: JSON.stringify(note), signal: AbortSignal.timeout(NOTE_TIMEOUT_MS) }));
    if (answer?.ok) return;
  } catch { /* reported below */ }
  console.error(JSON.stringify({ hop: 'session_device', ok: false }));
};

// A web sign-in names its session by the browser and system its User-Agent gives, when it gives either.
export const noteBrowserSession = async (owners: DurableObjectNamespace | undefined, doName: string, ownerCookie: string, request: Request): Promise<void> => {
  const device = browserSessionDevice(request.headers.get('user-agent')), session = device ? await credentialSessionHash(ownerCookie) : null;
  if (device && session) await noteSessionDevice(owners, doName, { session, device });
};

// The owner object's side of noteSessionDevice. false for a body the Worker would never send.
export const applySessionDeviceNote = (kv: Kv, body: unknown): boolean => {
  if (!body || typeof body !== 'object') return false;
  const note = body as { session?: unknown; device?: unknown; from?: unknown };
  if (typeof note.session !== 'string' || !SESSION_HASH.test(note.session)) return false;
  if (typeof note.from === 'string' && SESSION_HASH.test(note.from)) { sessionDevices(kv).carry(note.from, note.session); return true; }
  const device = note.device as { kind?: unknown; label?: unknown } | undefined;
  if (!device || !['phone', 'tablet', 'computer', 'unknown'].includes(device.kind as string) || typeof device.label !== 'string' || !device.label || device.label.length > APP_SESSION_LABEL_MAX_V1) return false;
  sessionDevices(kv).record(note.session, { kind: device.kind as SessionDevice['kind'], label: device.label });
  return true;
};
