import { appMessageIdV1Schema, appRatingRequestV1Schema, appRatingResultV1Schema } from '../../../contracts/src/app/core';
import { bodyDigest, type RequestBook } from '../onboarding/request-book';
import type { RatingScoreChange } from '../observability/langfuse-scores';

export const APP_RATING_SUFFIX = '/rating';
type Sql = Pick<SqlStorage, 'exec'>;

// The owner's Like or Dislike on each of Waldo's replies in main chat: the reply's id, the rating and when it was set.
// Ids only, never a reply's text. A rating changes style and which messages arrive, never what is true or what Waldo may do.
export const replyRatings = (sql: Sql) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS reply_ratings (
    message_id TEXT PRIMARY KEY, rating TEXT NOT NULL CHECK (rating IN ('up', 'down')), at INTEGER NOT NULL)`);
  // The Langfuse score that stands for each rating, so a change can delete the score it replaces.
  sql.exec('CREATE TABLE IF NOT EXISTS reply_rating_scores (message_id TEXT PRIMARY KEY, score_id TEXT NOT NULL)');
  return {
    // The rating a reply holds, or undefined when it has none.
    get(messageId: string): 'up' | 'down' | undefined {
      return sql.exec<{ rating: 'up' | 'down' }>('SELECT rating FROM reply_ratings WHERE message_id = ?', messageId).toArray()[0]?.rating;
    },
    // Setting the rating a reply already has, or clearing one it lacks, leaves the row as it was. Says whether it changed.
    set(messageId: string, rating: 'up' | 'down' | null, at: number): boolean {
      return (rating === null ? sql.exec('DELETE FROM reply_ratings WHERE message_id = ?', messageId)
        : sql.exec('INSERT INTO reply_ratings (message_id, rating, at) VALUES (?, ?, ?) ON CONFLICT (message_id) DO UPDATE SET rating = excluded.rating, at = excluded.at WHERE rating <> excluded.rating', messageId, rating, at)).rowsWritten > 0;
    },
    // Records the score now standing for the reply's rating, or none, and returns the one it replaces.
    swapScore(messageId: string, scoreId: string | null): string | null {
      const previous = sql.exec<{ score_id: string }>('SELECT score_id FROM reply_rating_scores WHERE message_id = ?', messageId).toArray()[0]?.score_id ?? null;
      if (scoreId === null) sql.exec('DELETE FROM reply_rating_scores WHERE message_id = ?', messageId);
      else sql.exec('INSERT INTO reply_rating_scores (message_id, score_id) VALUES (?, ?) ON CONFLICT (message_id) DO UPDATE SET score_id = excluded.score_id', messageId, scoreId);
      return previous;
    },
  };
};

export type AppRatingHost = Readonly<{
  ratings: ReturnType<typeof replyRatings>;
  requests: RequestBook;
  now(): number;
  transaction<T>(work: () => T): T;
  // Whether the id names one of Waldo's replies in this owner's main chat.
  isReply(messageId: string): Promise<boolean>;
  // Told once a changed rating is committed, with the score it adds and the one it replaces. Absent when nothing scores.
  scored?(change: RatingScoreChange): void;
}>;

const answer = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// PUT /app/v1/chat/main/messages/{message_id}/rating. `encodedId` is the path segment as sent. Anything but one of Waldo's
// replies in this owner's main chat is not found. A request_id answers once: the same request again returns its first result,
// and the id under a different message or rating is refused.
export const appRatingRequest = async (request: Request, encodedId: string, host: AppRatingHost): Promise<Response> => {
  let messageId: string;
  try { messageId = decodeURIComponent(encodedId); } catch { return answer({ error: 'unavailable' }, 404); }
  if (!appMessageIdV1Schema.safeParse(messageId).success) return answer({ error: 'unavailable' }, 404);
  let raw: unknown;
  try { raw = await request.json(); } catch { return answer({ error: 'invalid_request' }, 400); }
  const parsed = appRatingRequestV1Schema.safeParse(raw);
  if (!parsed.success) return answer({ error: 'invalid_request' }, 400);
  const { request_id: requestId, rating } = parsed.data;
  const route = `rating:${messageId}`, digest = await bodyDigest({ rating });
  const seen = host.requests.find(route, requestId, digest);
  if (seen.kind === 'reused') return answer({ error: 'request_reused', code: 'request_reused' }, 409);
  if (seen.kind === 'replay') return answer(seen.result);
  if (!await host.isReply(messageId)) return answer({ error: 'unavailable' }, 404);
  let change: RatingScoreChange | null = null;
  const response = host.transaction(() => {
    const again = host.requests.find(route, requestId, digest);
    if (again.kind === 'reused') return answer({ error: 'request_reused', code: 'request_reused' }, 409);
    if (again.kind === 'replay') return answer(again.result);
    const result = appRatingResultV1Schema.parse({ request_id: requestId, message_id: messageId, rating });
    if (host.ratings.set(messageId, rating, host.now()) && host.scored) {
      const added = rating === null ? null : { id: crypto.randomUUID(), value: rating === 'up' ? 1 as const : 0 as const };
      change = { messageId, removed: host.ratings.swapScore(messageId, added?.id ?? null), added };
    }
    host.requests.record(route, requestId, digest, result);
    return answer(result);
  });
  if (change) host.scored!(change);
  return response;
};
