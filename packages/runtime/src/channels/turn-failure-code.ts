// Typed, content-free failure classes for the owner-turn path. The trace-privacy gate drops
// free-form error text whenever capture is off, but a `code` survives by design - so failures
// stay diagnosable on staging (and safe on any environment) without a single character of
// provider or user content crossing the boundary. Vocabulary is fixed: only matches against
// known internal error shapes classify; everything else is 'unknown'.
export const turnFailureCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : '';
  const context = /^conversation context failed: ([a-z_]+)$/.exec(message);
  if (context) return `context_failed:${context[1]}`;
  if (/parameter bindings/.test(message)) return 'sql_binding_mismatch';
  if (/^illegal transition /.test(message)) return 'journal_transition';
  if (message === 'conversation model returned empty output') return 'model_empty';
  if (message === 'conversation owner authentication mismatch' || message === 'conversation invocation owner mismatch') return 'owner_mismatch';
  if (/^turn timed out after /.test(message)) return 'turn_timeout';
  return 'unknown';
};
