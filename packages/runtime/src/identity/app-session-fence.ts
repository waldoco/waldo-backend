import { routerSignature } from './owner-directory';

export const APP_SESSION_FENCE_PATH = '/app/v1/internal/session-fence';

// The Worker signs, the owner Durable Object verifies: the context is its own, so no other signed artifact can stand in for it.
export const appSessionFenceSignature = (secret: string, doName: string, sessionHash: string): Promise<string> =>
  routerSignature(secret, 0, `appfence.${doName}.${sessionHash}`);
