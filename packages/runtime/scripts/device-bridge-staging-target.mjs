// The owner's console cookie is only ever sent to a host the operator names exactly at run time.
// No substring, suffix or wildcard matching: `staging` in a hostname proves nothing about who owns it.
// Errors never echo the URL, allowlist or cookie.
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const unsafeHost = hostname => !hostname || hostname.endsWith('.') || hostname.startsWith('[') || IPV4.test(hostname)
  || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.split('.').some(label => label.startsWith('xn--'));

function allowedHosts(raw) {
  const entries = (raw ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error('WALDO_STAGING_ALLOWED_HOSTS is required (comma-separated exact staging hostnames)');
  return new Set(entries.map(entry => {
    let parsed;
    try { parsed = new URL(`https://${entry}`); } catch { parsed = null; }
    // Each entry must already be a bare, lowercase host[:port]; anything URL normalisation changes is refused.
    if (!parsed || parsed.host !== entry || parsed.username || parsed.password || unsafeHost(parsed.hostname))
      throw new Error('WALDO_STAGING_ALLOWED_HOSTS entries must be exact lowercase hostnames (optional :port), no scheme, path or wildcard');
    return entry;
  }));
}

export function stagingTarget(env) {
  const raw = env.WALDO_STAGING_URL;
  if (!raw) throw new Error('WALDO_STAGING_URL is required');
  const allowed = allowedHosts(env.WALDO_STAGING_ALLOWED_HOSTS);
  let url;
  try { url = new URL(raw); } catch { throw new Error('WALDO_STAGING_URL must be an absolute https URL'); }
  if (url.protocol !== 'https:') throw new Error('target must be an https staging host');
  if (url.username || url.password) throw new Error('target staging URL must not carry credentials');
  if (url.pathname !== '/' || url.search || url.hash || raw.includes('?') || raw.includes('#')) throw new Error('target staging URL must be a bare origin');
  if (unsafeHost(url.hostname)) throw new Error('target staging host must be a plain DNS name');
  // url.host carries a non-default port, so a port must be allowlisted explicitly.
  if (!allowed.has(url.host)) throw new Error('target staging host is not in WALDO_STAGING_ALLOWED_HOSTS');
  const cookie = env.WALDO_CONSOLE_COOKIE;
  if (!cookie) throw new Error('WALDO_CONSOLE_COOKIE is required at run time');
  if (/[\r\n]/.test(cookie)) throw new Error('WALDO_CONSOLE_COOKIE must be a single header line');
  return { origin: url.origin, cookie };
}
