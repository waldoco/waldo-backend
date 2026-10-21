# Reply context, Telegram first

The owner-turn envelope carries optional replyTo data with opaque message and author identifiers, an observed conversation reference, source surface, optional bot metadata, and a bounded text excerpt. Provider metadata is observed provenance, not authenticated authorship. All reply targets remain external even if their observed author id equals the owner id.

Telegram maps reply_to_message text or caption and observed identifiers. It discards names, recursive reply targets, attachments, and other unknown fields. The excerpt limit is 2048 characters. A reply to media without a caption carries the target id but no guessed content. Missing author and conversation metadata stay null.

The responder checks the quote separately as external data before adding it to the current model input. Rejection or a missing guard yields an unavailable-quote note rather than promoting quote bytes into owner text. The quote is ephemeral: not in the immediate memory writer input or stored owner conversation payload. Tool arguments for that turn and its children start external, preserving the existing privileged-action gate. This is conservative: an explicit mutation request attached to a quote must continue through the existing safe proposal/approval route rather than bypass the gate.

Prompt guidance asks the model to read follow-ups against their target and current work, state its assumed reading when uncertain, and ask one narrow confirmation. There is no punctuation/phrase routing. The quote does not assert current work status or authorize a change to it; the model still needs the current source.

## Other-channel mapping gaps

No new adapters are added here. WhatsApp currently travels through a compatibility adapter without provider reply/context projection. A later adapter must map provider message ids as opaque strings, observed sender and conversation ids, and text/caption through the same bounded external-data boundary. It must not invent missing quoted bytes or authenticate authorship from sender labels. Waldo iOS/app ingress likewise does not yet supply replyTo; a future host must verify its own reply reference and pass scoped quote data. The neutral responder accepts string ids and non-Telegram surfaces already.

## Validation layers

Adapter red: a real reply_to_message update previously lost the target. Real owner-DO ingress red: removing envelope mapping loses the target while a fixture calendar proposal is open. Quote-taint red: removing the per-turn external seed allows a scripted send handler to run.

Local fixtures exercise the real webhook, owner DO, listener and responder with intercepted model/channel/provider effects. They verify target provenance reaches the model, open proposal state remains open, provider effects do not run, quote bytes stay out of the memory writer, and later owner turns do not inherit the quote. These are plumbing and safety checks, not a claim about live model interpretation. CI and exact-head independent review are separate gates; no live model trial is claimed here.
