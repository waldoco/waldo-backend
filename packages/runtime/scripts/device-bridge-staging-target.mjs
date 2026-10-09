export function stagingTarget(env) {
  const raw = env.WALDO_STAGING_URL;
  if (!raw) throw new Error('WALDO_STAGING_URL is required');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !url.hostname.includes('staging')) throw new Error('target must be an https staging host');
  if (!env.WALDO_CONSOLE_COOKIE) throw new Error('WALDO_CONSOLE_COOKIE is required at run time');
  return { origin: url.origin, cookie: env.WALDO_CONSOLE_COOKIE };
}
