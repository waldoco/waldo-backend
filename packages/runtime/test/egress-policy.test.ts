import { describe, expect, it } from 'vitest';
import {
  evaluateDeclaredEgress,
  type DeclaredEgressPath,
} from '../src/hooks/egress-policy';

const NESTED_URL_PATHS = [
  { kind: 'url', path: ['callbacks', '*', 'target'] },
] as const satisfies readonly DeclaredEgressPath[];

const HOST_PATHS = [
  { kind: 'host', path: ['allow_hosts', '*'] },
] as const satisfies readonly DeclaredEgressPath[];

function evaluateUrl(target: string, allowlist: readonly string[] | undefined = ['fcc.gov', 'fda.gov']) {
  return evaluateDeclaredEgress(
    { callbacks: [{ target }] },
    NESTED_URL_PATHS,
    allowlist,
  );
}

describe('declared egress policy', () => {
  it.each([
    ['https://FCC.GOV:443/reports', 'fcc.gov'],
    ['https://fda.gov/notices', 'fda.gov'],
    ['https://[2606:4700:4700::1111]/', '2606:4700:4700::1111'],
  ])('allows normalized public URL %s', (target, host) => {
    expect(evaluateUrl(target, [host])).toEqual({ ok: true });
  });

  it.each([
    'http://[fc00::1]/',
    'http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/',
    'http://[fe80::1]/',
    'http://[fe90::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:8.8.8.8]/',
    'http://[::7f00:1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[100::1]/',
    'http://[fec0::1]/',
    'http://[ff02::1]/',
    'http://[2001:db8::1]/',
    'http://[2002:a00:1::]/',
    'http://[2d00::1]/',
    'http://[2e00::1]/',
    'http://[3000::1]/',
    'http://[3ff8::1]/',
    'http://[3ffe::1]/',
    'http://[3fff::1]/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://10.0.0.1/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/',
    'http://localhost/',
  ])('blocks private or special destination %s', (target) => {
    expect(evaluateUrl(target)).toEqual({ ok: false, reason: 'blocked_host' });
  });

  it.each([
    'ftp://fcc.gov/archive',
    'file:///etc/hosts',
    'https://user:pass@fcc.gov/reports',
    'https://fcc.gov:444/reports',
    'https://',
  ])('rejects malformed or unsupported URL shape %s', (target) => {
    expect(evaluateUrl(target)).toEqual({ ok: false, reason: 'malformed_target' });
  });

  it('fails closed when a declared target has no configured allowlist', () => {
    expect(
      evaluateDeclaredEgress(
        { callbacks: [{ target: 'https://fcc.gov/reports' }] },
        NESTED_URL_PATHS,
        undefined,
      ),
    ).toEqual({ ok: false, reason: 'allowlist_unavailable' });
  });

  it('inspects declared nested array paths without guessing other keys', () => {
    expect(
      evaluateDeclaredEgress(
        {
          callbacks: [{ target: 'https://fcc.gov/reports' }],
          nested: { callback_url: 'http://169.254.169.254/latest/meta-data' },
        },
        NESTED_URL_PATHS,
        ['fcc.gov'],
      ),
    ).toEqual({ ok: true });

    expect(
      evaluateDeclaredEgress(
        { callbacks: [{ target: 'http://169.254.169.254/latest/meta-data' }] },
        NESTED_URL_PATHS,
        ['fcc.gov'],
      ),
    ).toEqual({ ok: false, reason: 'blocked_host' });
  });

  it('rejects malformed values at declared paths', () => {
    expect(
      evaluateDeclaredEgress({ allow_hosts: 'fcc.gov' }, HOST_PATHS, ['fcc.gov']),
    ).toEqual({ ok: false, reason: 'malformed_target' });
  });

  it('keeps concurrent decisions independent', async () => {
    const results = await Promise.all([
      Promise.resolve(evaluateUrl('https://fcc.gov/reports', ['fcc.gov'])),
      Promise.resolve(evaluateUrl('http://127.1/', ['fcc.gov'])),
      Promise.resolve(evaluateUrl('https://fcc.gov.evil/reports', ['fcc.gov'])),
    ]);

    expect(results).toEqual([
      { ok: true },
      { ok: false, reason: 'blocked_host' },
      { ok: false, reason: 'host_not_allowlisted' },
    ]);
  });

  it('validates declared bare-host paths without treating hostnames as IPv6 prefixes', () => {
    expect(
      evaluateDeclaredEgress({ allow_hosts: ['fcc.gov', 'fda.gov'] }, HOST_PATHS, ['fcc.gov', 'fda.gov']),
    ).toEqual({ ok: true });
    expect(
      evaluateDeclaredEgress({ allow_hosts: ['fc00::1'] }, HOST_PATHS, ['fcc.gov']),
    ).toEqual({ ok: false, reason: 'blocked_host' });
  });
});

describe('open public mode: repeated trailing dots cannot hide an internal name', () => {
  const open = { openPublic: true } as const;
  it.each(['http://localhost../', 'http://foo.local../', 'http://a.b.internal../', 'http://svc.svc.../', 'http://box.localdomain../'])('url %s is denied', (target) => {
    expect(evaluateDeclaredEgress({ callbacks: [{ target }] }, NESTED_URL_PATHS, ['*'], open).ok).toBe(false);
  });
  it.each(['localhost..', 'foo.local..', 'a.b.internal..'])('bare host %s is denied', (host) => {
    expect(evaluateDeclaredEgress({ allow_hosts: [host] }, HOST_PATHS, ['*'], open).ok).toBe(false);
  });
});

describe('blocklist entries ("-host") alongside the open sentinel', () => {
  const open = { openPublic: true } as const;
  const check = (target: string, list: readonly string[]) => evaluateDeclaredEgress({ callbacks: [{ target }] }, NESTED_URL_PATHS, list, open);
  it('denies a blocked host and its subdomains, allows other public hosts', () => {
    const list = ['*', '-evil.example', '-Tracker.test'];
    expect(check('https://evil.example/a', list).ok).toBe(false);
    expect(check('https://sub.evil.example/a?x=1', list).ok).toBe(false);
    expect(check('https://tracker.test./', list).ok).toBe(false);
    expect(check('https://notevil.example/a', list)).toEqual({ ok: true });
    expect(check('https://news.example.org/', list)).toEqual({ ok: true });
  });
  it('no blocklist entries leaves open mode unchanged; hard blocks still win', () => {
    expect(check('https://news.example.org/', ['*'])).toEqual({ ok: true });
    expect(check('http://127.0.0.1/', ['*', '-evil.example']).ok).toBe(false);
  });
  it('a blocklist entry never acts as an allowlist entry and does not break the listed-host path', () => {
    expect(evaluateDeclaredEgress({ callbacks: [{ target: 'https://fcc.gov/' }] }, NESTED_URL_PATHS, ['fcc.gov', '-evil.example'])).toEqual({ ok: true });
    expect(evaluateDeclaredEgress({ callbacks: [{ target: 'https://evil.example/' }] }, NESTED_URL_PATHS, ['evil.example', '-evil.example']).ok).toBe(false);
  });
});
