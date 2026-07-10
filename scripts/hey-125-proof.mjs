import { randomBytes } from 'node:crypto';

const base = 'https://oqcjjcytjvrckvylagsl.supabase.co';
const issuer = `${base}/functions/v1/mint-agent-jwt`;
const adminKey = process.env.HEY125_ADMIN_API_KEY;
const authAdminKey = process.env.HEY125_AUTH_ADMIN_API_KEY;
const publishableKey = process.env.HEY125_PUBLISHABLE_API_KEY;
const registeredKid = 'cOhuxITY6ZJzBPSDIYRJtfZFmx3IEgG7eAYeobtyHZI';

if (!adminKey || !authAdminKey || !publishableKey) {
  throw new Error('HEY-125 proof API keys are required');
}

const results = [];
const fixtures = { auth: [], public: [] };

function secret(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function record(name, status, detail) {
  results.push({ name, pass: true, status, ...(detail ? { detail } : {}) });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function encodePart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function tamper(token, changeHeader, changeClaims, signature) {
  const parts = token.split('.');
  const header = changeHeader
    ? changeHeader(decodePart(parts[0]))
    : decodePart(parts[0]);
  const claims = changeClaims
    ? changeClaims(decodePart(parts[1]))
    : decodePart(parts[1]);
  return `${encodePart(header)}.${encodePart(claims)}.${signature ?? parts[2]}`;
}

async function request(label, url, init, expectedStatuses) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!expectedStatuses.includes(response.status)) {
    let diagnostic = '';
    try {
      const parsed = JSON.parse(text);
      diagnostic = ` (${String(parsed.code ?? 'unknown')}: ${String(
        parsed.message ?? 'no message',
      )})`;
    } catch {
      diagnostic = '';
    }
    diagnostic = diagnostic
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[uuid]')
      .replace(/hey125-[^@\s]+@example\.(?:com|invalid)/gi, '[fixture-email]');
    throw new Error(
      `${label} returned unexpected HTTP ${response.status}${diagnostic}`,
    );
  }
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function adminHeaders(extra = {}) {
  const headers = {
    apikey: adminKey,
    'content-type': 'application/json',
    ...extra,
  };
  if (!adminKey.startsWith('sb_secret_')) {
    headers.authorization = `Bearer ${adminKey}`;
  }
  return headers;
}

function userHeaders(token, extra = {}) {
  return {
    apikey: publishableKey,
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

function authAdminHeaders() {
  return {
    apikey: authAdminKey,
    authorization: `Bearer ${authAdminKey}`,
  };
}

async function createAuth(label) {
  const email = `hey125-${label.toLowerCase()}-${randomBytes(8).toString('hex')}@example.com`;
  const created = await request(
    `create auth ${label}`,
    `${base}/auth/v1/signup`,
    {
      method: 'POST',
      headers: { apikey: publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ data: { hey125_fixture: true } }),
    },
    [200],
  );
  assert(created.body?.user?.id, `create auth ${label} omitted id`);
  assert(created.body?.access_token, `create auth ${label} omitted access token`);
  fixtures.auth.push(created.body.user.id);
  return {
    authId: created.body.user.id,
    email,
    accessToken: created.body.access_token,
  };
}

async function createPublic(label, authUser) {
  const created = await request(
    `create public ${label}`,
    `${base}/rest/v1/users?select=id`,
    {
      method: 'POST',
      headers: adminHeaders({ prefer: 'return=representation' }),
      body: JSON.stringify({
        auth_id: authUser.authId,
        name: `HEY-125 Synthetic ${label}`,
        email: authUser.email,
        wearable_type: 'unknown',
      }),
    },
    [201],
  );
  assert(
    Array.isArray(created.body) && created.body.length === 1,
    `create public ${label} did not return one row`,
  );
  const publicId = created.body[0].id;
  fixtures.public.push(publicId);
  await request(
    `create consent ${label}`,
    `${base}/rest/v1/user_consents`,
    {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        user_id: publicId,
        policy_version: 'hey125-proof',
        health_data_consent: true,
        country_code: 'ZZ',
      }),
    },
    [201],
  );
  await request(
    `create health ${label}`,
    `${base}/rest/v1/health_daily`,
    {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        user_id: publicId,
        date: label === 'A' ? '2099-01-01' : '2099-01-02',
        primary_source: 'hey125_synthetic',
      }),
    },
    [201],
  );
  return { publicId };
}

async function mint(sessionToken, proofCase) {
  const headers = userHeaders(sessionToken);
  if (proofCase) headers['x-hey125-proof-case'] = proofCase;
  const minted = await request(
    `mint ${proofCase ?? 'valid'}`,
    `${issuer}/proof/mint`,
    { method: 'POST', headers },
    [200],
  );
  assert(minted.body?.rls_jwt, 'mint response omitted rls_jwt');
  return minted.body.rls_jwt;
}

async function dataGet(path, token, expectedStatuses = [200]) {
  const headers = token === null ? { apikey: publishableKey } : userHeaders(token);
  return request(
    `Data API ${path}`,
    `${base}/rest/v1/${path}`,
    { method: 'GET', headers },
    expectedStatuses,
  );
}

async function rejectProbe(name, token) {
  const response = await dataGet('users?select=id&limit=1', token, [401, 403]);
  record(name, response.status);
}

let runError = null;
try {
  const authA = await createAuth('A');
  const authB = await createAuth('B');
  const userA = await createPublic('A', authA);
  const userB = await createPublic('B', authB);

  const tokenA = await mint(authA.accessToken);
  const tokenB = await mint(authB.accessToken);
  const expiredA = await mint(authA.accessToken, 'expired');
  const tokenParts = tokenA.split('.');
  const headerA = decodePart(tokenParts[0]);
  const claimsA = decodePart(tokenParts[1]);
  assert(
    headerA.alg === 'ES256' &&
      headerA.typ === 'JWT' &&
      headerA.kid === registeredKid,
    'valid token header drift',
  );
  assert(claimsA.sub === authA.authId, 'minted sub is not verified A identity');
  assert(
    claimsA.role === 'authenticated' && claimsA.aud === 'authenticated',
    'role/aud drift',
  );
  assert(
    claimsA.iss === issuer && claimsA.actor === 'do-agent',
    'issuer/actor drift',
  );
  record('valid token exact header and claims', 200);

  const ownUserA = await dataGet(
    `users?select=id&auth_id=eq.${authA.authId}`,
    tokenA,
  );
  assert(
    Array.isArray(ownUserA.body) && ownUserA.body.length === 1,
    'A own users read was not exactly one',
  );
  record('A reads own users row', ownUserA.status, 'count=1');

  const ownUserB = await dataGet(
    `users?select=id&auth_id=eq.${authB.authId}`,
    tokenB,
  );
  assert(
    Array.isArray(ownUserB.body) && ownUserB.body.length === 1,
    'B own users read was not exactly one',
  );
  record('B reads own users row', ownUserB.status, 'count=1');

  const crossUser = await dataGet(
    `users?select=id&auth_id=eq.${authB.authId}`,
    tokenA,
  );
  assert(
    Array.isArray(crossUser.body) && crossUser.body.length === 0,
    'A could read B users row',
  );
  record('A denied B users row by RLS', crossUser.status, 'count=0');

  const ownHealth = await dataGet(
    `health_daily?select=id&user_id=eq.${userA.publicId}`,
    tokenA,
  );
  assert(
    Array.isArray(ownHealth.body) && ownHealth.body.length === 1,
    'A own health read was not exactly one',
  );
  record('A reads own synthetic health row', ownHealth.status, 'count=1');

  const crossHealth = await dataGet(
    `health_daily?select=id&user_id=eq.${userB.publicId}`,
    tokenA,
  );
  assert(
    Array.isArray(crossHealth.body) && crossHealth.body.length === 0,
    'A could read B health row',
  );
  record('A denied B synthetic health row by RLS', crossHealth.status, 'count=0');

  await rejectProbe('expired registered-key token rejected', expiredA);
  await rejectProbe('garbage signature rejected', tamper(tokenA, null, null, 'AA'));
  await rejectProbe(
    'wrong kid rejected',
    tamper(tokenA, (header) => ({ ...header, kid: 'wrong-kid' }), null),
  );
  await rejectProbe(
    'wrong issuer rejected',
    tamper(tokenA, null, (claims) => ({ ...claims, iss: 'https://issuer.invalid' })),
  );
  await rejectProbe(
    'wrong audience rejected',
    tamper(tokenA, null, (claims) => ({ ...claims, aud: 'wrong-audience' })),
  );
  await rejectProbe(
    'service_role-shaped tampered token rejected',
    tamper(tokenA, null, (claims) => ({ ...claims, role: 'service_role' })),
  );
  await rejectProbe(
    'alg none token rejected',
    `${encodePart({ alg: 'none', typ: 'JWT' })}.${tokenA.split('.')[1]}.`,
  );
  await rejectProbe('malformed bearer rejected', 'not-a-jwt');

  const missing = await dataGet('users?select=id&limit=1', null, [401, 403]);
  record('missing bearer rejected', missing.status);

  const bodyDenied = await request(
    'arbitrary body denied',
    `${issuer}/proof/mint`,
    {
      method: 'POST',
      headers: userHeaders(authA.accessToken, {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({
        sub: authB.authId,
        role: 'service_role',
        aud: 'authenticated',
      }),
    },
    [400],
  );
  record('mint seam rejects arbitrary sub/role body', bodyDenied.status);

  const nativeCross = await dataGet(
    `users?select=id&auth_id=eq.${authB.authId}`,
    authA.accessToken,
  );
  assert(
    Array.isArray(nativeCross.body) && nativeCross.body.length === 0,
    'native A session could read B row',
  );
  record('native session baseline also denies cross-user', nativeCross.status, 'count=0');
} catch (error) {
  runError = error;
} finally {
  let relationalCleanupFailed = false;
  let authCleanupFailed = false;
  async function cleanup(label, url, kind, headers = adminHeaders()) {
    try {
      await request(
        label,
        url,
        { method: 'DELETE', headers },
        [200, 204],
      );
    } catch {
      if (kind === 'auth') authCleanupFailed = true;
      else relationalCleanupFailed = true;
    }
  }
  for (const publicId of fixtures.public) {
    await cleanup(
      'delete health fixture',
      `${base}/rest/v1/health_daily?user_id=eq.${publicId}`,
      'relational',
    );
    await cleanup(
      'delete consent fixture',
      `${base}/rest/v1/user_consents?user_id=eq.${publicId}`,
      'relational',
    );
    await cleanup(
      'delete public fixture',
      `${base}/rest/v1/users?id=eq.${publicId}`,
      'relational',
    );
  }
  for (const authId of fixtures.auth) {
    await cleanup(
      'delete auth fixture',
      `${base}/auth/v1/admin/users/${authId}`,
      'auth',
      authAdminHeaders(),
    );
  }
  results.push({
    name: 'synthetic relational fixture cleanup',
    pass: !relationalCleanupFailed,
    status: relationalCleanupFailed ? 500 : 204,
  });
  results.push({
    name: 'synthetic Auth fixture cleanup',
    pass: !authCleanupFailed,
    status: authCleanupFailed ? 500 : 204,
  });
  const cleanupFailed = relationalCleanupFailed || authCleanupFailed;
  process.stdout.write(
    `${JSON.stringify(
      { passed: runError === null && !cleanupFailed, results },
      null,
      2,
    )}\n`,
  );
  if (runError) process.stderr.write(`Matrix failure: ${runError.message}\n`);
  if (cleanupFailed) process.stderr.write('Fixture cleanup failed\n');
  if (runError || cleanupFailed) process.exitCode = 1;
}
