// A Google account granted mail but not calendar, stored as the owner object keeps it. The brief sweep is kept only while a
// Google grant exists; with this one it runs and makes no calendar read.
export const MAIL_ONLY_GOOGLE = [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only',
  scopes: ['readonly', 'send', 'compose'].map(scope => `https://www.googleapis.com/auth/gmail.${scope}`) }];
