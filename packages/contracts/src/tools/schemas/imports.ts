import { z } from 'zod';
import { lifeAreaSchema } from '../../memory/area';

// Bringing the owner's past in from another assistant's chat export, uploaded by the owner to their workspace. What is worth
// keeping is the model's judgment; code holds provenance: the file is the owner's own upload, and every quote sits in a
// message the owner wrote there, never in the other assistant's replies.
export const IMPORT_SOURCES = ['chatgpt', 'claude'] as const;
export const importSourceSchema = z.enum(IMPORT_SOURCES);
export type ImportSource = z.infer<typeof importSourceSchema>;
export const IMPORT_CLAIMS_PER_CALL = 20;

const exportFile = { source: importSourceSchema, file_id: z.string().min(1).max(100), revision: z.int().positive() };
const conversationId = z.string().min(1).max(200);

// Without conversation_ids: the export's conversations, newest first. With them: the owner's own messages in those.
export const readImportArgsSchema = z.strictObject({
  ...exportFile,
  conversation_ids: z.array(conversationId).min(1).max(10).optional(),
  cursor: z.int().nonnegative().optional(),
});
export type ReadImportArgs = z.infer<typeof readImportArgsSchema>;

// A health condition the owner described is kind health, so it keeps health's fences in memory; a reading in an old chat is
// neither current nor the health plane's, and the handler refuses one in any kind.
export const importClaimKindSchema = z.enum(['fact', 'preference', 'routine', 'goal', 'followup', 'event', 'health']);
export const importMemoriesArgsSchema = z.strictObject({
  ...exportFile,
  claims: z.array(z.strictObject({
    kind: importClaimKindSchema,
    text: z.string().trim().min(1).max(500),
    // Long enough to identify one passage: forgetting the import hides the claim's words across chat history.
    evidence_quote: z.string().trim().min(12).max(500),
    conversation_id: conversationId,
    area: lifeAreaSchema.optional(),
  })).min(1).max(IMPORT_CLAIMS_PER_CALL),
});
export type ImportMemoriesArgs = z.infer<typeof importMemoriesArgsSchema>;
