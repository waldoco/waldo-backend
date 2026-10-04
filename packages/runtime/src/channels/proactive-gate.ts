import { isQuiet, type Proactivity } from './loops';

// One pure decision for source-grounded proactive work. Deployment flag is the master switch; the
// owner setting (default off, stored per owner) decides per owner. First failing reason is reported.
export type ProactiveKind = 'mail_followup' | 'calendar_prep' | 'reminder';
export type ProactiveGateInput = Readonly<{
  kind: ProactiveKind; flag: string | undefined; ownerEnabled: boolean; googleConnected: boolean;
  proactivity: Proactivity; now: number; timezone: string;
}>;
export type ProactiveGate = Readonly<{ open: true } | { open: false; reason: 'flag_off' | 'owner_off' | 'no_google' | 'volume_low' | 'quiet_hours' }>;

export const proactiveGate = (input: ProactiveGateInput): ProactiveGate => {
  // Owner-set reminders are explicit requests, not proactive work: never gated here.
  if (input.kind === 'reminder') return { open: true };
  if (input.flag !== '1') return { open: false, reason: 'flag_off' };
  if (!input.ownerEnabled) return { open: false, reason: 'owner_off' };
  if (!input.googleConnected) return { open: false, reason: 'no_google' };
  if (input.proactivity.volume === 'low') return { open: false, reason: 'volume_low' };
  if (isQuiet(input.proactivity, input.now, input.timezone)) return { open: false, reason: 'quiet_hours' };
  return { open: true };
};
