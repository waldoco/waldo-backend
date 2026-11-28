import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import { appApprovalLink, appCaller } from '../src/channels/surfaces/app';
import { sha256Hex, type GoogleClient } from '../src/connectors/google';
import { approvalHandlers } from '../src/tools/live/raise-approval';

// The desk tells the owner's phone an approval is waiting in the app: once, when its card first opens there, and never from
// inside the owner's own app turn, whose reply push covers it.
const desk = (name: string, over: Readonly<{ surface?: 'app' | 'telegram'; inAppTurn?: boolean; push?: (id: string) => Promise<void> }>, run: (tools: Readonly<{
  propose(subject: string): Promise<string>; pushed: string[]; decide(id: string): Promise<unknown>; raise(id: string): Promise<unknown>;
}>) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), async (_instance, state) => {
    let n = 0;
    const pushed: string[] = [], surface = over.surface ?? 'app';
    const client = { sendRaw: async () => ({ message_id: 'g1' }) } as unknown as GoogleClient;
    const call = surface === 'app' ? appCaller() : async (method: string) => method === 'sendMessage' ? { message_id: 1, chat: { id: 42 } } : true;
    const built = approvalDesk(state.storage.sql, { surface, owner: surface === 'app' ? 7_000_000_000_006 : 42, call, appLink: appApprovalLink,
      appIdentity: () => true, google: async () => client, newId: () => `${name}${++n}`, now: () => Date.now(), timezone: 'UTC', log: () => {},
      currentRunRef: () => 'scope-run-0001', ...(over.inAppTurn ? { conversationRef: () => 'chain:app:owner' } : {}),
      appPush: over.push ?? (async id => { pushed.push(id); }) });
    const handler = approvalHandlers(built).find(candidate => candidate.name === 'raise_approval')!;
    await run({ pushed,
      propose: async subject => {
        const raw = `To: e@x.test\r\nSubject: ${subject}\r\n\r\nA short note.`;
        return built.proposeSendEmail({ to: ['e@x.test'], subject, body: 'A short note.', message_id: `<${subject.toLowerCase()}@waldo-send>`, raw, digest: await sha256Hex(raw) });
      },
      decide: id => built.decide(id, 'd', 'app:approval', { surface: 'app' }),
      raise: id => handler.handle(handler.schema.parse({ operation: 'raise', approval_id: id }) as never) });
  });

it('a card that opens in the app outside an app turn pushes once, with its approval id', async () => {
  await desk('push-once', {}, async ({ propose, pushed }) => {
    const id = await propose('Hello');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pushed).toEqual([id]);
  });
});

it('a card a chat surface hands to the app pushes too, since the owner is not looking at the app', async () => {
  await desk('push-handed', { surface: 'telegram' }, async ({ propose, pushed }) => {
    const id = await propose('Hello');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pushed).toEqual([id]);
  });
});

it('a card raised in the owner\'s own app turn pushes nothing: the reply push covers it', async () => {
  await desk('push-in-turn', { inAppTurn: true }, async ({ propose, pushed }) => {
    await propose('Hello');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pushed).toEqual([]);
  });
});

it('raising a card again after Not now pushes no second time', async () => {
  await desk('push-raise', {}, async ({ propose, decide, raise, pushed }) => {
    const id = await propose('Later');
    await decide(id);
    await raise(id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pushed).toEqual([id]);
  });
});

it('a push that fails or hangs never fails the card', async () => {
  await desk('push-fails', { push: async () => { throw new Error('push directory unavailable'); } }, async ({ propose }) => {
    await expect(propose('Hello')).resolves.toMatch(/push-fails/);
  });
  await desk('push-hangs', { push: () => new Promise<void>(() => undefined) }, async ({ propose }) => {
    await expect(propose('Hello')).resolves.toMatch(/push-hangs/);
  });
});
