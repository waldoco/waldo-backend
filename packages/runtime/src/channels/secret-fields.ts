// Credential values never render on any surface. This is a secrets boundary, not a judgment:
// exact field names, compared after folding camelCase, spaces and hyphens to snake_case, plus the
// input types and autocomplete tokens a page uses to mark a field as secret. Only rendered text is
// masked; frozen payloads keep the values the executor compares and submits.
const CREDENTIAL_KEYS = new Set([
  'password', 'passwd', 'passcode', 'current_password', 'new_password', 'one_time_code', 'otp',
  'cc_number', 'card_number', 'cc_csc', 'cvv', 'cvc', 'security_code', 'cc_exp', 'cc_exp_month', 'cc_exp_year',
  'api_key', 'apikey', 'secret', 'client_secret', 'token', 'access_token', 'refresh_token', 'id_token', 'authorization',
  'session_token', 'sessionid', 'x_amz_security_token', 'x_amz_signature', 'x_amz_credential', 'x_goog_signature', 'x_goog_credential',
]);
// Names that carry secrets in a URL but are ordinary content in a form or tool argument (an email
// signature, an issue key), where masking them would hide what is being approved.
const URL_CREDENTIAL_KEYS = new Set([...CREDENTIAL_KEYS, 'key', 'sig', 'signature', 'session']);
const SECRET_AUTOCOMPLETE = new Set(['one-time-code', 'current-password', 'new-password', 'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year']);

export const MASK = '••••';
const keyName = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');
export const isCredentialKey = (key: string) => CREDENTIAL_KEYS.has(keyName(key));

export const isSecretField = (field: Readonly<{ type?: string; autocomplete?: string }>) =>
  field.type?.toLowerCase() === 'password'
  || (field.autocomplete ?? '').toLowerCase().split(/\s+/).some(token => SECRET_AUTOCOMPLETE.has(token));

export const maskedValue = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(maskedValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isCredentialKey(k) ? MASK : maskedValue(v)]))
      : value;

const decodedKey = (key: string) => { try { return decodeURIComponent(key.replace(/\+/g, ' ')); } catch { return key; } };
// Each parameter keeps its original encoding, so an encoded `&` or `=` inside a value cannot be
// displayed as a second parameter; only the value of a credential-named key is replaced.
const maskedParams = (params: string) => params.split('&').map(part => {
  const eq = part.indexOf('=');
  return eq > 0 && URL_CREDENTIAL_KEYS.has(keyName(decodedKey(part.slice(0, eq)))) ? `${part.slice(0, eq)}=${MASK}` : part;
}).join('&');
// A fragment is masked as parameters when it is parameter-shaped (`#access_token=…`) or a
// hash-router route with a query (`#/reset?token=…`).
const maskedFragment = (fragment: string) => {
  const query = fragment.indexOf('?');
  return query >= 0 ? `${fragment.slice(0, query + 1)}${maskedParams(fragment.slice(query + 1))}`
    : fragment.includes('=') ? maskedParams(fragment) : fragment;
};

// The URL as reviewed: every parameter stays visible, because parameters can change what the action
// does; userinfo and credential-named parameter values are masked.
export const maskedUrl = (url: string) => {
  const page = new URL(url);
  const fragment = page.hash.slice(1);
  return `${page.protocol}//${page.username || page.password ? `${MASK}@` : ''}${page.host}${page.pathname}${page.search ? `?${maskedParams(page.search.slice(1))}` : ''}`
    + (fragment ? `#${maskedFragment(fragment)}` : '');
};
