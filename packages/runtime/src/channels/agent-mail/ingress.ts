import { agentMailRoute, type OwnerDirectoryEnv } from '../../identity/owner-directory';
import type { OwnerDO } from '../owner-do';
import { AGENT_MAIL_HANDLE } from './handles';
import { AGENT_MAIL_RAW_MAX, AGENT_MAIL_REFERENCES_MAX, type AgentMailAdmission, type AgentMailDelivery } from './inbox';

// The Worker's email handler. Mail is routed by its envelope recipient alone, through the owner directory, and only while
// AGENT_MAIL_INBOUND is "1" and the recipient's domain is AGENT_MAIL_DOMAIN. A message is handed to that owner's object,
// which decides whether it is read; this returns once that write is done. Nothing here replies or bounces: a dropped
// message is accepted and discarded, so a forged sender never gets backscatter.

export type AgentMailEnv = OwnerDirectoryEnv & Readonly<{ AGENT_MAIL_INBOUND?: string; AGENT_MAIL_DOMAIN?: string; OWNER_DO?: DurableObjectNamespace }>;
// off: the flag or domain is not set. not_routed: another domain, not a handle, or no live handle. oversize: over the
// inbound limit. unavailable: the directory, the message body or the owner's object could not be read or reached.
//
// The failure policy. A throw from the email handler makes Cloudflare refuse the message during the SMTP session, so the
// sending server keeps it and may retry; nothing here calls setReject, whose bounce would go to a sender that may be
// forged. The handler throws only when the message was not recorded and a later delivery could be (unavailable). Every
// other outcome, including mail it will never read (off, not_routed, oversize, cold_dropped, over_cap, duplicate), is
// accepted and dropped, so a stranger learns nothing about which handles exist or what Waldo reads.
export type AgentMailCode = 'off' | 'not_routed' | 'oversize' | 'unavailable' | AgentMailAdmission;
export type InboundEmail = Pick<ForwardableEmailMessage, 'to' | 'headers' | 'raw' | 'rawSize'>;


// One content-free line per delivery: never an address, subject, body, filename or Message-ID.
const logged = (code: AgentMailCode): AgentMailCode => { console.log(JSON.stringify({ hop: 'agent_mail_inbound', code })); return code; };

// Message-IDs in a Message-ID, In-Reply-To or References header, without their angle brackets.
export const messageIds = (value: string | null): string[] => value === null ? [] : [...value.matchAll(/<([^<>\s]{1,998})>/g)].map(match => match[1]!);

// Every address the From header names, lower-cased. Quoted display names and comments are removed first, so a display
// name that looks like an address is never taken for one. A group, or a part that is not one address, counts as an
// address no owner has, so the message is not taken for the owner's.
export const fromAddresses = (value: string | null): string[] => {
  if (value === null) return [];
  const bare = value.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\((?:[^()\\]|\\.)*\)/g, ' ');
  return bare.split(/,(?![^<]*>)/).map(part => part.trim()).filter(Boolean).map(part => {
    const angled = [...part.matchAll(/<([^<>]*)>/g)];
    const address = angled.length === 1 ? angled[0]![1]!.trim() : angled.length === 0 ? part : '';
    return /^[^\s@<>:;,]+@[^\s@<>:;,]+$/.test(address) ? address.toLowerCase() : '(not an address)';
  });
};

export async function receiveAgentMail(message: InboundEmail, env: AgentMailEnv): Promise<AgentMailCode> {
  if (env.AGENT_MAIL_INBOUND !== '1' || !env.AGENT_MAIL_DOMAIN || !env.OWNER_DO) return logged('off');
  const at = message.to.lastIndexOf('@');
  const handle = message.to.slice(0, at).toLowerCase();
  if (at <= 0 || message.to.slice(at + 1).toLowerCase() !== env.AGENT_MAIL_DOMAIN.toLowerCase() || !AGENT_MAIL_HANDLE.test(handle)) return logged('not_routed');
  if (message.rawSize > AGENT_MAIL_RAW_MAX) return logged('oversize');
  let route;
  try { route = await agentMailRoute(env, handle); }
  catch { logged('unavailable'); throw new Error('agent mail directory unavailable'); }
  if (!route) return logged('not_routed');
  let raw: Uint8Array;
  try { raw = new Uint8Array(await new Response(message.raw).arrayBuffer()); }
  catch { logged('unavailable'); throw new Error('agent mail body unreadable'); }
  if (raw.byteLength > AGENT_MAIL_RAW_MAX) return logged('oversize');
  const { headers } = message;
  const delivery: AgentMailDelivery = {
    handle, messageId: messageIds(headers.get('message-id'))[0] ?? null, inReplyTo: messageIds(headers.get('in-reply-to')),
    references: messageIds(headers.get('references')).slice(-AGENT_MAIL_REFERENCES_MAX), from: fromAddresses(headers.get('from')),
    ownerEmail: route.ownerEmail, raw,
  };
  const owner = env.OWNER_DO.get(env.OWNER_DO.idFromName(route.doName)) as unknown as DurableObjectStub<OwnerDO>;
  let code: AgentMailAdmission | 'not_routed';
  try { code = await owner.admitAgentMail(route.doName, delivery); }
  catch { logged('unavailable'); throw new Error('agent mail owner unavailable'); }
  return logged(code);
}
