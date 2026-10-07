import { expect, it } from 'vitest';
import { commonOwnerTools } from '../src/channels/common-owner-tool-policy';

it('common loop admits read-only mail reads only with Google, and no effect tools', () => {
  const off = commonOwnerTools({ googleConnected: false, driveReads: false, publicSearch: false, browser: false });
  const on = commonOwnerTools({ googleConnected: true, driveReads: false, publicSearch: false, browser: false });
  for (const name of ['get_communication', 'read_thread', 'search_communication']) {
    expect(off).not.toContain(name);
    expect(on).toContain(name);
  }
  for (const effect of ['send_email', 'send_message', 'draft_email', 'propose_calendar_change', 'set_reminder']) expect(on).not.toContain(effect);
  expect(on.length).toBeLessThanOrEqual(32);
});
