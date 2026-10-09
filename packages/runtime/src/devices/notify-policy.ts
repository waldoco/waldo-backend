import { NOTIFICATION_BODY_CHOICES, NOTIFICATION_TITLE } from './contract';
import type { NotifyPayload } from './wire';
export function notificationScope(payload: NotifyPayload): boolean {
  // Owner-selected neutral status presets prevent private content or secrets leaving through notifications.
  return payload.title === NOTIFICATION_TITLE && NOTIFICATION_BODY_CHOICES.some((body) => payload.body === body);
}
