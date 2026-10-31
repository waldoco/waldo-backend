// What the owner reads before claiming a Waldo address, shown by the app and the console exactly as given. Claiming is the
// owner's opt-in; the claim names this version and the directory keeps it, with the time, beside the handle. Every number
// here is a constant in this directory's code: change the text and its version together with them. The draft paragraph
// for privacy notice v3 is docs/channels/agent-mail/PRIVACY_NOTICE_V3_DRAFT.md.
export const AGENT_MAIL_NOTICE = {
  version: '2026-10-31',
  text: [
    'Your Waldo address receives mail for Waldo. Waldo reads mail from the address you sign in with, and replies in email threads it is part of. Anything else is discarded unread; Waldo only counts it.',
    'Mail is outside content: anyone can write any From line, so Waldo never treats a mail as you, and asks you before acting on anything in it.',
    'Waldo reads the message, its sender and recipients, subject, body and up to four attachments, with the AI model provider that runs Waldo, as it does your chat. It keeps the message only until it has read it, at most 24 hours, then a fingerprint for 30 days to recognise a repeat, and the message IDs of its threads until you delete your account. What Waldo tells you about a mail stays in your chat. Mail reaches Waldo through Cloudflare, which holds the routing for your address.',
    'Releasing or changing the address stops its mail at once: mail Waldo has not read yet is discarded unread, and no one, you included, can claim that address for 180 days.',
  ].join('\n\n'),
} as const;
