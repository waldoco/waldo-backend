import { onlyArtifacts, quarantineArtifacts } from '../security/artifact-hygiene';
// Minimal WhatsApp Cloud API caller (WHATSAPP_CHANNEL_SPEC W2): text sends only for the webhook's
// link-code replies. The full gated send surface (buttons, templates, the owner-0 drop gate) is W3.
export type WhatsAppCall = (body: object) => Promise<unknown>;

export const createWhatsAppCaller = (token: string, phoneNumberId: string, fetcher: typeof fetch = fetch): WhatsAppCall =>
  async (body) => {
    const response = await fetcher(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    if (!response.ok) throw new Error(`whatsapp ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  };

export const sendWhatsAppText = (call: WhatsAppCall, to: string, text: string) =>
  call({ to, type: 'text', text: { body: text } });

// Telegram-shaped shim over the Cloud API (the OpenClaw channel-plugin pattern: normalize the
// provider behind one call interface so the turn pipeline never branches on provider, and the
// reply always goes back out the channel it came in on). sendMessage maps to a text send; buttons
// flatten to reply instructions because WhatsApp interactive replies carry no callback_data, so
// approval cards arrive as "reply a:<id>" lines. Everything else is a logged no-op.
export type TelegramShimCall = (method: string, body: object) => Promise<unknown>;

export const whatsappTelegramShim = (token: string, phoneNumberId: string, to: string, fetcher: typeof fetch = fetch): TelegramShimCall => {
  const call = createWhatsAppCaller(token, phoneNumberId, fetcher);
  return async (method, body) => {
    if (method === 'sendMessage') {
      const b = body as { text: string; reply_markup?: { inline_keyboard?: { text: string; callback_data?: string }[][] } };
      const buttons = (b.reply_markup?.inline_keyboard ?? []).flat().filter((x) => x.callback_data);
      const suffix = buttons.length ? `\n\n${buttons.map((x) => `- ${x.text}: reply "${x.callback_data}"`).join('\n')}` : '';
      return sendWhatsAppText(call, to, b.text + suffix);
    }
    console.log(JSON.stringify({ hop: 'whatsapp_shim', ok: true, skipped: method }));
    return {};
  };
};

export const WA_UPDATE_BASE = 9_000_000_000_000;

export type WaIngressMessage = Readonly<{ id?: string; from?: string; type?: string; text?: { body?: string } }>;
export type WaSyntheticUpdate = Readonly<Record<string, unknown>>;

// Pure normalization for /whatsapp-turn: each of the owner's text messages becomes a
// telegram-shaped update (subject digits double as the numeric owner/chat id; ids live in the
// 9e12 namespace so they never collide with telegram update ids). An approval reply "a:p12"
// synthesizes the equivalent callback_query because WhatsApp buttons carry no callback_data.
// Non-text messages and any foreign sender are skipped.
export const whatsappIngressUpdates = (messages: readonly WaIngressMessage[], subject: string, seqStart: number): { updates: WaSyntheticUpdate[]; seq: number } => {
  let seq = seqStart;
  const ownerNum = Number(subject);
  const updates: WaSyntheticUpdate[] = [];
  for (const message of messages) {
    if (message.from !== subject || message.type !== 'text') continue;
    const text = (message.text?.body ?? '').trim();
    if (!text) continue;
    seq += 1;
    // E1 (issue #150): verification artifacts in the owner's inbound text are redacted before the
    // update exists, so no downstream consumer (turn pipeline, episodes, traces) ever sees the raw
    // code or link. The original stays owner-inspectable in their own WhatsApp thread. Approval
    // replies are channel commands that can never carry an artifact, so they skip the filter.
    if (/^([aseurx]):(\S+)$/.exec(text)) {
      updates.push({ update_id: WA_UPDATE_BASE + seq, callback_query: { id: `wa-${message.id ?? seq}`, from: { id: ownerNum }, data: text, message: { message_id: 0, chat: { id: ownerNum } } } });
      continue;
    }
    const q = quarantineArtifacts(text);
    const clean = q.kinds.length === 0 ? text : onlyArtifacts(q) ? `[quarantined: ${q.kinds.join('/')} artifact - see your WhatsApp thread]` : q.text;
    updates.push({ update_id: WA_UPDATE_BASE + seq, message: { from: { id: ownerNum }, chat: { id: ownerNum, type: 'private' }, text: clean } });
  }
  return { updates, seq };
};
