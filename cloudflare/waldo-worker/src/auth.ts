import type { RuntimeEnvironment } from "./env";

export type AuthContext = {
  userId: string;
};

type LocalAuthEnv = {
  ENVIRONMENT?: RuntimeEnvironment | string;
};

const LOCAL_BEARER_PREFIX = "Bearer local-user:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLocalAuthStub(request: Request, env: LocalAuthEnv): AuthContext | null {
  if (env.ENVIRONMENT !== "local") {
    return null;
  }

  const authorization = request.headers.get("Authorization");

  if (!authorization?.startsWith(LOCAL_BEARER_PREFIX)) {
    return null;
  }

  const userId = authorization.slice(LOCAL_BEARER_PREFIX.length).trim();

  if (!UUID_PATTERN.test(userId)) {
    return null;
  }

  return { userId };
}
