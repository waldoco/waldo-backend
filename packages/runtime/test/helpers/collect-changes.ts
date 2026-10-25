import type { GoogleClient } from '../../src/connectors/google';
import { readChanges, writeChanges, type Change, type UpdateBook } from '../../src/channels/update-cards';

// What a sweep tick records outside a job: the changes read, then written with their watermarks.
export const collectChanges = async (book: UpdateBook, google: Pick<GoogleClient, 'changedEvents' | 'newMail'>, now: number, sourceFollowups = false): Promise<readonly Change[]> => {
  const read = await readChanges(book, google, now, sourceFollowups);
  writeChanges(book, read);
  return read.changes;
};
