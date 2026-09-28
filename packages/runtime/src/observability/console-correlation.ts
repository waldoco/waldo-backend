// Request-local correlation only: never encode email, phone, IP, cookie, or URL.
// A response header lets a developer match a reported console problem to a Worker log.
export const consoleTrace = () => `console-${crypto.randomUUID()}`;
export const consoleLog = (trace: string, hop: string, ok: boolean, code: string) => {
  console.log(JSON.stringify({ trace, hop, ok, code }));
};
export const withConsoleTrace = (response: Response, trace: string): Response => {
  const headers = new Headers(response.headers);
  headers.set('x-waldo-trace', trace);
  // Preserve body stream and status, while adding only a content-free correlation header.
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
