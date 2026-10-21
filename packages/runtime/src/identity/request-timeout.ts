// Shared directory/Auth request bound, including response decoding. Abort is best effort;
// the race also closes callers when an injected fetch or decoder ignores the signal.
export const REQUEST_TIMEOUT_MS = 10_000;
export const withRequestTimeout = async <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const closed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('request timeout'));
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  });
  try { return await Promise.race([work(controller.signal), closed]); }
  finally { clearTimeout(timer!); }
};
