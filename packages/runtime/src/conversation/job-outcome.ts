import type { ConversationEntry } from '@waldo/contracts';
import { sha256Hex } from '../context-composer/canonical';

// A background job's prompt is its working material, not the owner's conversation. Its row keeps the chain's shape (a
// request, then the reply the owner was sent) but holds only a key: the model never reads it, and a retry of the same job
// matches the key to replay its saved reply. The key holds no word, so a forget of the owner's words leaves it intact.
export const jobPromptKey = async (said: string): Promise<string> => `#${await sha256Hex(said)}`;

export const jobPromptStub = (entry: ConversationEntry, key: string): ConversationEntry =>
  ({ ...entry, modelPayload: key, appPayload: '', modelProjection: { mode: 'omit' } });

export const jobOutcomeRowsEnabled = (env: Readonly<{ WALDO_JOB_OUTCOME_ROWS?: string }>): boolean => env.WALDO_JOB_OUTCOME_ROWS === '1';
