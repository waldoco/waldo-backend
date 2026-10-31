import { createSupabaseIdentityVerifier } from '../../../packages/mint-agent-jwt/src/index.ts';
import {
  createGoogleConnectHandler,
  createPostgrestGoogleConnectStore,
} from '../../../packages/google-connect/src/index.ts';

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const projectUrl = requiredEnv('SUPABASE_URL');

Deno.serve(
  createGoogleConnectHandler({
    functionUrl: `${projectUrl.replace(/\/$/, '')}/functions/v1/google-connect`,
    clientId: requiredEnv('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: requiredEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    appReturnUrl: requiredEnv('GOOGLE_CONNECT_APP_RETURN_URL'),
    verifyIdentity: createSupabaseIdentityVerifier({
      projectUrl,
      publishableKey: requiredEnv('SUPABASE_ANON_KEY'),
    }),
    store: createPostgrestGoogleConnectStore({
      projectUrl,
      serviceRoleKey: requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    }),
  }),
);
