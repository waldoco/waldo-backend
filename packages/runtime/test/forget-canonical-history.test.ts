import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { redactConversationEntries } from '../src/channels/conversation-store';

// Admitted-owner history is stored by ownerCanonicalHistory under canonical-owner-v1:<principal>:<tenant>: with
// conv:* rows AND witness:<id> copies of each entry. Forget must reach all of them.
const P = 'canonical-owner-v1:prn_x:ten_x:';
const entry = (id: string, text: string) => ({ id, ownerId: 'prn_x', modelPayload: text, appPayload: text, modelProjection: { mode: 'same' } });

describe('forget reaches the canonical owner history', () => {
  it('rewrites canonical conv rows and their witness copies', async () => {
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-canonical')), async (_i, state) => {
      const e = entry('e1', 'SYNTH: my zebra code word is plum');
      await state.storage.put({ [`${P}conv:0000000000`]: e, [`${P}witness:e1`]: { lineage: 'canonical_v1', principal_ref: 'prn_x', tenant_ref: 'ten_x', entry: e } });
      const receipt = await redactConversationEntries(state.storage, ['zebra code word', 'my zebra code word is plum'], '[forgotten]');
      const all = JSON.stringify([...(await state.storage.list({ prefix: P })).values()]);
      expect(all).not.toMatch(/zebra code word/i);
      expect(receipt.rewritten).toBeGreaterThan(0);
    });
  });
});
