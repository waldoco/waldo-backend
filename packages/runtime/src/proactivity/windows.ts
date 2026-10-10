import { ProactivityConflict, type ProactivityPolicy, type Window } from './types';

const clock = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
export function validatePolicy(policy: ProactivityPolicy): void {
  if (!Number.isSafeInteger(policy.revision) || policy.revision < 1 || typeof policy.enabled !== 'boolean') throw new ProactivityConflict('invalid_input');
  if (policy.volume !== undefined && !['low', 'normal', 'high'].includes(policy.volume) || policy.followups !== undefined && typeof policy.followups !== 'boolean') throw new ProactivityConflict('invalid_input');
  try { new Intl.DateTimeFormat('en', { timeZone: policy.timezone }).format(0); } catch { throw new ProactivityConflict('invalid_input'); }
  for (const window of [...policy.processingWindows, ...policy.notificationWindows]) {
    if (!clock(window.start) || !clock(window.end) || window.days.length === 0 || window.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new ProactivityConflict('invalid_input');
  }
  if (policy.quietHours && (!clock(policy.quietHours.start) || !clock(policy.quietHours.end))) throw new ProactivityConflict('invalid_input');
}
function localParts(now: number, timezone: string): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (name: string) => parts.find(value => value.type === name)!.value;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday')), time: `${part('hour')}:${part('minute')}` };
}
function inWindow(window: Window, day: number, time: string): boolean {
  if (window.start === window.end) return window.days.includes(day);
  if (window.start < window.end) return window.days.includes(day) && time >= window.start && time < window.end;
  // An overnight window belongs to the day on which it starts.
  return window.days.includes(day) && time >= window.start || window.days.includes((day + 6) % 7) && time < window.end;
}
export function withinWindows(windows: readonly Window[], now: number, timezone: string): boolean {
  if (!windows.length) return true;
  const { day, time } = localParts(now, timezone);
  return windows.some(window => inWindow(window, day, time));
}
export function processingAllowed(policy: ProactivityPolicy, now: number): boolean {
  return policy.enabled && withinWindows(policy.processingWindows, now, policy.timezone);
}
export function notificationAllowed(policy: ProactivityPolicy, now: number): boolean {
  if (!policy.enabled || !withinWindows(policy.notificationWindows, now, policy.timezone)) return false;
  if (!policy.quietHours || policy.quietHours.start === policy.quietHours.end) return true;
  const { time } = localParts(now, policy.timezone), { start, end } = policy.quietHours;
  return !(start < end ? time >= start && time < end : time >= start || time < end);
}
