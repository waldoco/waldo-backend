import { appMessageIdV1Schema, appRatingRequestV1Schema, appRatingResultV1Schema } from '../../../contracts/src/app/core';
import { bodyDigest, type RequestBook } from '../onboarding/request-book';

export const APP_RATING_SUFFIX = '/rating';
type Sql = Pick<SqlStorage, 'exec'>;

// The owner's Like or Dislike on each of Waldo's replies in main chat: the reply's id, the rating and when it was set.
// Ids only, never a reply's text. A rating changes style and which messages arrive, never what is true or what Waldo may do.
export const replyRatings = (sql: Sql) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS reply_ratings (
    message_id TEXT PRIMARY KEY, rating TEXT NOT NULL CHECK (rating IN ('up', 'down')), at INTEGER NOT NULL)`);
  return {
    // Setting the rating a reply already has, or clearing one it lacks, leaves the row as it was.
    set(messageId: string, rating: 'up' | 'down' | null, at: number): void {
      if (rating === null) sql.exec('DELETE FROM reply_ratings WHERE message_id = ?', messageId);
      else sql.exec('INSERT INTO reply_ratings (message_id, rating, at) VALUES (?, ?, ?) ON CONFLICT (message_id) DO UPDATE SET rating = excluded.rating, at = excluded.at WHERE rating <> excluded.rating', messageId, rating, at);
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
  return host.transaction(() => {
    const again = host.requests.find(route, requestId, digest);
    if (again.kind === 'reused') return answer({ error: 'request_reused', code: 'request_reused' }, 409);
    if (again.kind === 'replay') return answer(again.result);
    const result = appRatingResultV1Schema.parse({ request_id: requestId, message_id: messageId, rating });
    host.ratings.set(messageId, rating, host.now());
    host.requests.record(route, requestId, digest, result);
    return answer(result);
  });
};
