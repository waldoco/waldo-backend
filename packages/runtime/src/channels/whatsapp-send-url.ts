// Pure helper (no Worker or Durable Object imports): the app API and the console both use it, and the app API also
// loads in plain Node for the scenario tests.

/** Waldo's WhatsApp number as E.164 digits without the plus, or null where it is unset or not 8 to 15 digits. */
export const whatsAppWaldoNumber = (value: string | undefined): string | null => value && /^[1-9]\d{7,14}$/.test(value) ? value : null;

/** WhatsApp's click-to-chat link: it opens a chat with the Waldo number with "waldo CODE" filled in. */
export const whatsAppSendUrl = (digits: string, code: string) => `https://wa.me/${digits}?text=${encodeURIComponent(`waldo ${code}`)}`;
