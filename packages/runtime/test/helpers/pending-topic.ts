import { textFingerprint } from '../../src/memory/claims';

// A topic the owner asked to forget whose purge has not settled yet: the row the forget core leaves between purge and settle.
export const holdTopic = (sql: Pick<SqlStorage, 'exec'>, topic: string, at: string): void => {
  sql.exec('INSERT OR IGNORE INTO topic_purge_pending (fingerprint, topic, created_at) VALUES (?, ?, ?)', textFingerprint(topic), topic, at);
};
