// Pure helper (no Worker or Durable Object imports): the app API and the console both use it, and the app API also
// loads in plain Node for the scenario tests.

/** The one-tap link: on an iPhone it opens Messages to the Waldo address with "waldo CODE" filled in. */
export const iMessageSendUrl = (address: string, code: string) => `sms:${encodeURIComponent(address).replace(/%40/g, '@').replace(/%2B/g, '+')}&body=${encodeURIComponent(`waldo ${code}`)}`;
