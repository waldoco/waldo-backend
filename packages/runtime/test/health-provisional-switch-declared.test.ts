import { describe, expect, it } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';

// The provisional-scores switch is on for staging only, for the synthetic one-owner check; production stays off. The staging values around it are
// asserted too, so a merge that takes one side of the vars line cannot silently revert them.
type Vars = Readonly<Record<string, string>>;
const parsed = parseJsonc(config) as { vars: Vars; env: { staging: { vars: Vars } } };

describe('HEALTH_PROVISIONAL_SCORES in the Worker config', () => {
  it('is on for staging and off for production', () => {
    expect(parsed.vars.HEALTH_PROVISIONAL_SCORES).toBe('0');
    expect(parsed.env.staging.vars.HEALTH_PROVISIONAL_SCORES).toBe('1');
  });
  it('leaves the staging vars the gate turned on as they are', () => {
    expect(parsed.env.staging.vars.APP_AGREEMENTS).toBe('1');
    expect(parsed.env.staging.vars.OWNER_LOOKUP).toBe('1');
    expect(parsed.env.staging.vars.WHATSAPP_DEBUG_LOG).toBe('false');
  });
  it('leaves production\'s own values as they are', () => {
    expect(parsed.vars.APP_AGREEMENTS).toBe('0');
    expect(parsed.vars.OWNER_LOOKUP).toBe('0');
    expect(parsed.vars.WHATSAPP_DEBUG_LOG).toBe('false');
  });
});

describe('HEALTH_SOLO_NOTICE in the Worker config', () => {
  it('is on for staging and off for production', () => {
    expect(parsed.vars.HEALTH_SOLO_NOTICE).toBe('0');
    expect(parsed.env.staging.vars.HEALTH_SOLO_NOTICE).toBe('1');
  });
});

describe('HEALTH_TRAINING_LOAD in the Worker config', () => {
  it('is on for staging, which deploys with migration 20261031170000, and off for production', () => {
    expect(parsed.vars.HEALTH_TRAINING_LOAD).toBe('0');
    expect(parsed.env.staging.vars.HEALTH_TRAINING_LOAD).toBe('1');
  });
});

describe('HEALTH_COACHING in the Worker config', () => {
  it('is off in both blocks until the gate turns it on at a named deploy', () => {
    expect(parsed.vars.HEALTH_COACHING).toBe('0');
    expect(parsed.env.staging.vars.HEALTH_COACHING).toBe('0');
  });
});

describe('HEALTH_EASE_WORKOUT in the Worker config', () => {
  it('is off in both blocks until the gate turns it on at a named deploy, after the connector-proxy function is redeployed', () => {
    expect(parsed.vars.HEALTH_EASE_WORKOUT).toBe('0');
    expect(parsed.env.staging.vars.HEALTH_EASE_WORKOUT).toBe('0');
  });
});

describe('CALENDAR_UNDO_CANCEL in the Worker config', () => {
  it('is off in both blocks until the gate turns it on at a named deploy, after the connector-proxy function is redeployed', () => {
    expect(parsed.vars.CALENDAR_UNDO_CANCEL).toBe('0');
    expect(parsed.env.staging.vars.CALENDAR_UNDO_CANCEL).toBe('0');
  });
});
