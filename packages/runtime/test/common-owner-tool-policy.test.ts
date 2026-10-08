import { expect, it } from 'vitest';
import { commonOwnerTools } from '../src/channels/common-owner-tool-policy';

it('common loop keeps reminders and admits reviewed Google tools through their approval paths', () => {
  const off = commonOwnerTools({ googleConnected: false, driveReads: false, publicSearch: false, browser: false });
  const on = commonOwnerTools({ googleConnected: true, driveReads: false, publicSearch: false, browser: false });
  for (const name of ['get_communication', 'search_communication', 'read_thread', 'draft_email', 'send_email', 'propose_calendar_change']) {
    expect(off).not.toContain(name);
    expect(on).toContain(name);
  }
  for (const name of ['set_reminder', 'cancel_reminder', 'list_reminders']) expect(off).toContain(name);
  for (const effect of ['send_message', 'execute_action']) expect(on).not.toContain(effect);
  expect(on.length).toBeLessThanOrEqual(32);
});
