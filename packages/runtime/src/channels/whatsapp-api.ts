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
