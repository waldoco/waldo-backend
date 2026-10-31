import {
  sendAgentMailArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type SendAgentMailArgs, type ToolEligibility, type ToolHandler, type ToolName, type ToolResult,
} from '@waldo/contracts';
import { EmailProposalError, proposalStatus, type CardPlacement } from '../../channels/approvals';
import { ownerEffectOperationRef } from '../../channels/owner-effect-ledger';
import { agentMailDirectory, agentMailFirstName } from '../../channels/agent-mail/handles';
import { agentMailInbox } from '../../channels/agent-mail/inbox';
import { validMessageId } from '../../channels/agent-mail/render';
import { agentMailPartsDigest, agentMailSending, renderAgentMailDraft, type AgentMailSendEnv, type AgentMailSendProposal } from '../../channels/agent-mail/send';
import type { OwnerDirectoryEnv } from '../../identity/owner-directory';
import { sha256Hex } from '../../connectors/google';
import type { ToolDispatcherContext } from '../dispatcher';

export type AgentMailToolHost = Readonly<{
  // The agent mail domain while sending as Waldo is on and configured, else null.
  domain(): string | null;
  // The handle the owner holds, or null. Throws when the directory cannot say.
  handle(): Promise<string | null>;
  ownerName(): string | null;
  // The References of a reply to this Message-ID, or null when Waldo is not part of its thread.
  replyReferences(inReplyTo: string): readonly string[] | null;
  desk: Readonly<{ proposeAgentMailSend(payload: AgentMailSendProposal): Promise<string>; placement?(id: string): CardPlacement }>;
}>;

// The owner object's host: the flags and binding from env, the handle from the directory, the threads from its own inbox.
export const agentMailToolHost = (env: AgentMailSendEnv & OwnerDirectoryEnv, storage: DurableObjectStorage, doName: () => string | undefined,
  ownerName: () => string | null, desk: AgentMailToolHost['desk']): AgentMailToolHost => ({
  domain: () => agentMailSending(env)?.domain ?? null,
  handle: async () => {
    const name = doName(), directory = name ? agentMailDirectory(env, name) : null;
    if (!directory) throw new Error('agent mail directory unavailable');
    return (await directory.current())?.handle ?? null;
  },
  ownerName,
  replyReferences: id => agentMailInbox(storage).replyReferences(id),
  desk,
});

const allowlist = (name: ToolName) => triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes(name));
const refused = (error: string): ToolResult<unknown> => ({ ok: false, code: 'rejected', error, source_taint: null });

export const sendAgentMailHandler = (host: AgentMailToolHost): ToolHandler<SendAgentMailArgs, unknown, ToolDispatcherContext> => ({
  name: 'send_agent_mail',
  description: "Send an email as Waldo itself, from the owner's Waldo address, signed as their assistant; send_email sends from the owner's own Gmail instead. The owner gets a review card with the exact sender, recipients, subject and words, and nothing sends until they approve it. To reply in a mail thread Waldo is part of, set in_reply_to to the Message-ID of the mail it answers. body_markdown takes paragraphs, **bold**, *italic*, [links](https://…), lists and one table.",
  schema: sendAgentMailArgsSchema,
  trigger_allowlist: allowlist('send_agent_mail'),
  autonomy_gated: false,
  mutates_state: true,
  proposal_only: true,
  eligible: (): ToolEligibility => host.domain() === null ? { ok: false, reason: 'not_configured' } : { ok: true },
  handle: async (args: SendAgentMailArgs, ctx?: ToolDispatcherContext): Promise<ToolResult<unknown>> => {
    const domain = host.domain();
    if (!domain) return refused('Sending email as Waldo is not turned on for this Waldo, so nothing was proposed.');
    let handle: string | null;
    try { handle = await host.handle(); }
    catch { return { ok: false, code: 'transient', error: "I couldn't check the owner's Waldo address just now, so nothing was proposed. Try again shortly.", source_taint: null }; }
    if (!handle) return refused('The owner has no Waldo address yet, so Waldo cannot send as itself. They can choose one in the Waldo app; nothing was proposed.');
    const references = args.in_reply_to ? host.replyReferences(args.in_reply_to)?.filter(validMessageId) ?? null : undefined;
    if (references === null) return refused('That Message-ID is not in a mail thread Waldo is part of, so it cannot be answered from the Waldo address. Leave in_reply_to out to start a new email; nothing was proposed.');
    const first = agentMailFirstName(host.ownerName()), address = `${handle}@${domain}`;
    const draft = {
      owner_first_name: first, to: args.to, cc: args.cc ?? [], body_markdown: args.body_markdown,
      ...(args.in_reply_to ? { in_reply_to: args.in_reply_to } : {}), ...(references?.length ? { references } : {}),
    };
    const rendered = renderAgentMailDraft({ ...draft, subject: args.subject, from: { address } });
    if (!rendered.ok) return refused(`The email could not be prepared (${rendered.code}), so nothing was proposed. Fix it and propose it again.`);
    const idempotency_key = await sha256Hex(JSON.stringify([ctx?.authenticatedUserId ?? null, ctx?.turnId ?? crypto.randomUUID(), args]));
    const operation_ref = await ownerEffectOperationRef(ctx);
    try {
      const proposal_id = await host.desk.proposeAgentMailSend({
        ...(operation_ref ? { operation_ref } : {}), idempotency_key, handle, ...draft,
        from: rendered.preview.from, subject: rendered.preview.subject, body: rendered.preview.text, parts_digest: await agentMailPartsDigest(rendered.parts),
      });
      return { ok: true, data: { proposal_id, status: proposalStatus(host.desk.placement?.(proposal_id), 'review card requested in chat; nothing was sent', 'Nothing was sent.'), sent: false }, source_taint: null };
    } catch (error) {
      if (!(error instanceof EmailProposalError)) return { ok: false, code: 'transient', error: 'The email proposal could not be prepared. Nothing was sent; check chat before retrying.', source_taint: null };
      return refused(error.reason === 'card_unconfirmed'
        ? 'The review card delivery was not confirmed. Nothing was sent. Check chat before asking for a fresh proposal.'
        : error.reason === 'identifier_reused'
          ? 'This send was already proposed with different content. Nothing was sent; ask for a fresh proposal.'
          : 'This email proposal was already handled. No new email was sent; check chat before asking again.');
    }
  },
});
