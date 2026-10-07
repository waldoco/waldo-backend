import { expect, it } from 'vitest';
import { commonOwnerTools } from '../src/channels/common-owner-tool-policy';

it('common loop admits read-only mail reads only with Google, and no effect tools', () => {
  const off = commonOwnerTools({ googleConnected: false, driveReads: false, publicSearch: false, browser: false });
  const on = commonOwnerTools({ googleConnected: true, driveReads: false, publicSearch: false, browser: false });
  for (const name of ['get_communication', 'search_communication']) {
    expect(off).not.toContain(name);
    expect(on).toContain(name);
  }
  // read_thread relays artifacts straight to the owner chat; held until it has an approved delivery path.
  expect(on).not.toContain('read_thread');
  for (const name of ['set_reminder', 'cancel_reminder', 'list_reminders']) expect(off).toContain(name);
  for (const effect of ['send_email', 'send_message', 'draft_email', 'propose_calendar_change']) expect(on).not.toContain(effect);
  expect(on.length).toBeLessThanOrEqual(32);
});
