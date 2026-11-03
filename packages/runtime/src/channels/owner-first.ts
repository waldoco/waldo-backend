import { APP_INBOX_DUE_KEY, WHATSAPP_INBOX_DUE_KEY } from '../scheduler/alarm-slot';
import { IMESSAGE_INBOX_DUE_KEY } from './imessage/owner-inbox';
import { OWNER_INBOX_KEY, type InboxRecord } from './telegram-owner-inbox';

// Owner messages before machine work. The alarm pass is one unit on the owner object's serial chain, so a message admitted
// while it runs would wait behind every apply turn and day card left in it. With WALDO_OWNER_FIRST=1 the pass looks before
// each machine turn: an owner message that can run now ends the pass, its machine work stays due for the next one, and the
// owner's turn takes the chain. One writer still: the pass yields; nothing runs beside it.
export const ownerFirst = (env: Readonly<{ WALDO_OWNER_FIRST?: string }>): boolean => env.WALDO_OWNER_FIRST === '1';

// Each surface inbox marks an admitted message due a moment after admission. A message whose wake was put off (its owner's
// authority could not be read, a WhatsApp quiet window still open) is not waiting yet: counting it would end every pass early
// and spin the alarm until it is due.
const DUE_GRACE_MS = 1_000;
const OWNER_INBOX_DUE_KEYS = [APP_INBOX_DUE_KEY, IMESSAGE_INBOX_DUE_KEY, WHATSAPP_INBOX_DUE_KEY] as const;

export const ownerMessageWaiting = (kv: Pick<SyncKvStorage, 'get'>, now: number): boolean =>
  OWNER_INBOX_DUE_KEYS.some(key => { const due = kv.get<number | null>(key); return typeof due === 'number' && due <= now + DUE_GRACE_MS; })
  || (kv.get<InboxRecord[]>(OWNER_INBOX_KEY) ?? []).some(row => row.state === 'admitted' && !row.control);
