export const CONTRACT_VERSION = '0.2.3';
export const CAPABILITIES = ['machine_state_query', 'notify_local'] as const;
export type Capability = typeof CAPABILITIES[number];
export const REDEEM_BYTES = 2048;
export const FRAME_BYTES = 8192;
export const CLOCK_SKEW_SECONDS = 300;
export const ONLINE_SECONDS = 90;
export const PAIRING_SECONDS = 600;
export const CONSOLE_DEVICES_PATH = '/console/devices';
export const LABEL_BYTES = 120;
export const IDENTIFIER_BYTES = 128;
export const OUTBOX_DEPTH_MAX = 1_000_000;
export const JSON_DEPTH_MAX = 128;
export const PAIRING_MINT_ATTEMPTS = 3;
export const TIMESTAMP_MAX = 9_999_999_999;
export const KEY_BYTES = 32;
export const NONCE_BYTES = 16;
export const SIGNATURE_BYTES = 64;
export const MAX_DEVICE_FRAME_FINGERPRINTS = 10_000_000;
export const CONNECT_RATE_KEY_PREFIX = 'devconnect.ip';
export const CONNECT_RATE_PROFILE = { limit: 120, period: 60 } as const;
export const REDEEM_THROTTLES = [
  { prefix: 'devredeem.ip60', limit: 5, seconds: 60 },
  { prefix: 'devredeem.ip3600', limit: 20, seconds: 3600 },
  { prefix: 'devredeem.code', limit: 5, seconds: PAIRING_SECONDS },
] as const;
export const COMMAND_DEFAULT_TTL_SECONDS = 3600;
export const COMMAND_MAX_TTL_SECONDS = 86400;
export const MAX_DEVICE_COMMANDS = 100000;
export const NOTIFY_TITLE_BYTES = 120;
export const NOTIFY_BODY_BYTES = 1024;
export const NOTIFY_ISSUE_LIMITS = [{ limit: 5, seconds: 60 }, { limit: 20, seconds: 3600 }] as const;
export const NOTIFICATION_TITLE = 'Waldo status';
export const NOTIFICATION_BODY_CHOICES = ['Your Mac is connected.', 'Your Mac needs attention.', 'Status update'] as const;
