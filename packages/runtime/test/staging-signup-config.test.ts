import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { flatConfig } from '../../../scripts/wrangler-vars.mjs';
import { openOwnerCeilingUsd, openSignupCaps } from '../src/identity/open-signup';
import { phoneSms } from '../src/identity/phone-sms';
import { phoneControls, type WhatsAppProof } from '../src/channels/dashboard-phone';
import { whatsappProactiveTemplateConfig, whatsappTemplateConfig } from '../src/channels/whatsapp-window';

// Staging's sign-up and phone-proof settings read as the Worker reads them, flattened out of WALDO_SWITCHES.
const flat = flatConfig(parseJsonc(config)) as { vars: Record<string, string>; env: { staging: { vars: Record<string, string> } } };
const STAGING = flat.env.staging.vars;
const PRODUCTION = flat.vars;

const directory = { SUPABASE_PROJECT_URL: 'https://directory.test', SUPABASE_PUBLISHABLE_KEY: 'publishable', WALDO_ROUTER_HMAC_SECRET: 'router-secret' };
const twilio = { TWILIO_ACCOUNT_SID: `AC${'c'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'synthetic-twilio-token-for-tests', TWILIO_VERIFY_SERVICE_SID: `VA${'a'.repeat(32)}` };
const PHONE = '+919800000001';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('open sign-up on staging', () => {
  it('is on with its caps and ceiling, and off in production', () => {
    expect(STAGING.OPEN_SIGNUP).toBe('1');
    expect(openSignupCaps(STAGING)).toEqual({ dailyCap: 10, totalCap: 80 });
    expect(openOwnerCeilingUsd(STAGING)).toBe(5);
    expect(openSignupCaps(PRODUCTION)).toBeNull();
  });

  it('turns itself off, and says so, when the agreements or the cost ledger are not on', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(openSignupCaps({ ...STAGING, APP_AGREEMENTS: '0' })).toBeNull();
    expect(openSignupCaps({ ...STAGING, WALDO_COST_LEDGER_SYNC: 'off' })).toBeNull();
    expect(openSignupCaps({ ...STAGING, OPEN_SIGNUP_DAILY_CAP: '' })).toBeNull();
    expect(logged).toHaveBeenCalledTimes(3);
    expect(String(logged.mock.calls[0]![0])).toContain('open_signup_misconfigured');
  });
});

describe('the texted code on staging', () => {
  it('is on for +91 with the daily limit, and off in production', () => {
    expect(STAGING).toMatchObject({ PHONE_SMS_VERIFY: '1', PHONE_SMS_COUNTRIES: '+91', PHONE_SMS_DAILY_LIMIT: '20' });
    expect(PRODUCTION.PHONE_SMS_VERIFY).toBe('0');
  });

  it('is offered once Twilio is configured, and not before: no call goes out and the owner is told it is not available', async () => {
    expect(phoneSms({ ...STAGING, ...directory, ...twilio }).offered).toBe(true);
    const fetcher = vi.fn(async () => Response.json({}));
    const bare = phoneSms({ ...STAGING, ...directory }, fetcher);
    expect(bare.offered).toBe(false);
    expect(await bare.send('owner-a')).toEqual({ kind: 'disabled' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  const ledger = (phone: string | null) => vi.stubGlobal('fetch', vi.fn(async () => Response.json({ phone, verified: false, challenge: null })));
  const whatsappOffered: WhatsAppProof = { offered: async () => true, hint: async () => null };

  it('sits beside the WhatsApp link code: both are listed as ways to prove the number', async () => {
    ledger(PHONE);
    const both = await phoneControls({ ...STAGING, ...directory, ...twilio }, 'owner-a', 'csrf', undefined, Date.now(), whatsappOffered);
    expect(both.data).toMatchObject({ phone: PHONE, verified: false, sms: true, actions: ['phone.sms_send', 'phone.set'], proof: ['sms', 'whatsapp'] });
  });

  it('leaves WhatsApp as the only way when Twilio is not configured', async () => {
    ledger(PHONE);
    const whatsappOnly = await phoneControls({ ...STAGING, ...directory }, 'owner-a', 'csrf', undefined, Date.now(), whatsappOffered);
    expect(whatsappOnly.data).toMatchObject({ phone: PHONE, sms: false, actions: [], proof: ['whatsapp'] });
  });
});

describe('the WhatsApp knock templates on staging', () => {
  it('knocks with the approved reply template, and has no proactive one until Meta approves it', () => {
    expect(whatsappTemplateConfig(STAGING)).toEqual({ name: 'waldo_update_ready', language: 'en' });
    expect(whatsappProactiveTemplateConfig(STAGING)).toBeNull();
  });

  it('configures none in production', () => {
    expect(whatsappTemplateConfig(PRODUCTION)).toBeNull();
    expect(whatsappProactiveTemplateConfig(PRODUCTION)).toBeNull();
  });
});

describe('what stays off on staging', () => {
  it('keeps iMessage progress notes off by owner ruling, and console Google sign-in off until the redirect is allowed', () => {
    expect(STAGING.WALDO_IMESSAGE_PROGRESS).toBe('0');
    expect(STAGING.CONSOLE_GOOGLE_SIGNIN).toBe('0');
  });
});
