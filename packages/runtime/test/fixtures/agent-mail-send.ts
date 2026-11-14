import { agentMailPartsDigest, renderAgentMailDraft, type AgentMailSendProposal } from '../../src/channels/agent-mail/send';

type Draft = Readonly<{ handle?: string; domain?: string; owner_first_name?: string | null; to?: readonly string[]; cc?: readonly string[]; subject?: string; body_markdown?: string;
  in_reply_to?: string; references?: readonly string[]; idempotency_key?: string; operation_ref?: string }>;

// The card send_agent_mail freezes for a draft: the rendered words, the sender and the digest of the parts it sends.
export const agentMailProposal = async (draft: Draft = {}): Promise<AgentMailSendProposal> => {
  const { handle = 'sam', domain = 'mail.example.test', owner_first_name = 'Sam', to = ['lee@example.test'], cc = [], subject = 'Friday', body_markdown = 'See you at **4**.' } = draft;
  const fields = { owner_first_name, to, cc, subject, body_markdown, ...(draft.in_reply_to ? { in_reply_to: draft.in_reply_to } : {}), ...(draft.references ? { references: draft.references } : {}) };
  const rendered = renderAgentMailDraft({ ...fields, from: { address: `${handle}@${domain}` } });
  if (!rendered.ok) throw new Error(`fixture does not render: ${rendered.code}`);
  return { ...(draft.operation_ref ? { operation_ref: draft.operation_ref } : {}), idempotency_key: draft.idempotency_key ?? `key-${crypto.randomUUID()}`, handle, ...fields,
    from: rendered.preview.from, subject: rendered.preview.subject, body: rendered.preview.text, parts_digest: await agentMailPartsDigest(rendered.parts) };
};
