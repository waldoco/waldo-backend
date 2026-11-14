import { APP_ACT_WITHOUT_ASKING_RECEIPTS_V1, type AppActWithoutAskingV1 } from '../../../contracts/src/app/controls';

type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;

// The owner's "Just do it" choice (act_without_asking): Waldo does what the owner asks without an approval card first. On
// unless the owner turned it off, so an owner who never chose reads on. It takes effect only where AUTONOMOUS_BY_DEFAULT is 1
// (available); elsewhere it is kept and changes nothing, and every consequential effect is a card as before.
export const ACT_WITHOUT_ASKING_KEY = 'act_without_asking_v1';
export const actWithoutAskingOn = (kv: Pick<Kv, 'get'>): boolean => kv.get<boolean>(ACT_WITHOUT_ASKING_KEY) !== false;
export const actWithoutAsking = (kv: Pick<Kv, 'get'>, available: boolean): AppActWithoutAskingV1 => ({ on: actWithoutAskingOn(kv), available });
// Whether the approval desk runs owner-asked work with no card for this owner: the deploy's master switch and the owner's choice.
export const actsWithoutAsking = (kv: Pick<Kv, 'get'>, available: boolean): boolean => available && actWithoutAskingOn(kv);
// Saves the choice, also where it is not active yet, and says which. Anything but on or off changes nothing.
export const setActWithoutAsking = (kv: Kv, value: string, available: boolean) => {
  if (value !== 'on' && value !== 'off') return false;
  const was = actWithoutAskingOn(kv), on = value === 'on';
  kv.put(ACT_WITHOUT_ASKING_KEY, on);
  if (!available) return APP_ACT_WITHOUT_ASKING_RECEIPTS_V1[on ? 'inactive_on' : 'inactive_off'];
  return APP_ACT_WITHOUT_ASKING_RECEIPTS_V1[was === on ? (on ? 'already_on' : 'already_off') : on ? 'on' : 'off'];
};
