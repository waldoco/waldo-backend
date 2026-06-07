export type AuthContext = {
  userId: string;
};

const LOCAL_BEARER_PREFIX = "Bearer local-user:";

export function parseLocalAuthStub(request: Request): AuthContext | null {
  const authorization = request.headers.get("Authorization");

  if (!authorization?.startsWith(LOCAL_BEARER_PREFIX)) {
    return null;
  }

  const userId = authorization.slice(LOCAL_BEARER_PREFIX.length).trim();

  if (userId.length === 0) {
    return null;
  }

  return { userId };
}
