import type { ConversationEntry } from '@waldo/contracts';
import { sha256Hex } from '../context-composer/canonical';

// A background job's prompt is its working material, not the owner's conversation. Its row keeps the chain's shape (a
// request, then the reply the owner was sent) but holds only a key: the model never reads it, and a retry of the same job
// matches the key to replay its saved reply. A forget rewrites a literal only between word edges, which digits never have, so
// the digest is spelled in the letters a-p: one unbroken run of letters that no forgotten word or number can match inside.
export const jobPromptKey = async (said: string): Promise<string> =>
  `#${(await sha256Hex(said)).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)))}`;

export const jobPromptStub = (entry: ConversationEntry, key: string): ConversationEntry =>
  ({ ...entry, modelPayload: key, appPayload: '', modelProjection: { mode: 'omit' } });

export const jobOutcomeRowsEnabled = (env: Readonly<{ WALDO_JOB_OUTCOME_ROWS?: string }>): boolean => env.WALDO_JOB_OUTCOME_ROWS === '1';
