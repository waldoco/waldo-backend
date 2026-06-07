export type RuntimeEnvironment = "local" | "staging" | "production";

export type Env = {
  ENVIRONMENT?: RuntimeEnvironment | string;
  SUPABASE_URL?: string;
  WALDO_WORKER_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
};

export type RuntimeConfig = {
  environment: RuntimeEnvironment;
  supabaseUrl: string;
  waldoWorkerUrl?: string;
};

function isRuntimeEnvironment(value: string | undefined): value is RuntimeEnvironment {
  return value === "local" || value === "staging" || value === "production";
}

export function readRuntimeConfig(env: Env): RuntimeConfig | null {
  if (env.SUPABASE_SERVICE_ROLE_KEY !== undefined) {
    return null;
  }

  if (!isRuntimeEnvironment(env.ENVIRONMENT)) {
    return null;
  }

  const supabaseUrl = env.SUPABASE_URL?.trim();

  if (!supabaseUrl) {
    return null;
  }

  const waldoWorkerUrl = env.WALDO_WORKER_URL?.trim();

  return {
    environment: env.ENVIRONMENT,
    supabaseUrl,
    ...(waldoWorkerUrl ? { waldoWorkerUrl } : {})
  };
}
