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
  it('is on for staging, which deploys with migrations 20261101000000 and 20261101020000, and off for production', () => {
    expect(parsed.vars.HEALTH_COACHING).toBe('0');
    expect(parsed.env.staging.vars.HEALTH_COACHING).toBe('1');
  });
});

describe('HEALTH_EASE_WORKOUT in the Worker config', () => {
  it('is off in production and on in staging, which runs the redeployed connector-proxy function', () => {
    expect(parsed.vars.HEALTH_EASE_WORKOUT).toBe('0');
    expect(parsed.env.staging.vars.HEALTH_EASE_WORKOUT).toBe('1');
  });
});

describe('CALENDAR_UNDO_CANCEL in the Worker config', () => {
  it('is off in production and on in staging, which runs the redeployed connector-proxy function', () => {
    expect(parsed.vars.CALENDAR_UNDO_CANCEL).toBe('0');
    expect(parsed.env.staging.vars.CALENDAR_UNDO_CANCEL).toBe('1');
  });
});

describe('WHY_TRAIL in the Worker config', () => {
  it('is off in production and on in staging', () => {
    expect(parsed.vars.WHY_TRAIL).toBe('0');
    expect(parsed.env.staging.vars.WHY_TRAIL).toBe('1');
  });
});

describe('HISTORY_ARCHIVE in the Worker config', () => {
  it('is off in production and counts only (dry) in staging', () => {
    expect(parsed.vars.HISTORY_ARCHIVE).toBe('0');
    expect(parsed.env.staging.vars.HISTORY_ARCHIVE).toBe('dry');
  });
});

describe('MEDICATIONS in the Worker config', () => {
  it('is off in both blocks until the gate turns it on at a named deploy with migration 20261101040000', () => {
    expect(parsed.vars.MEDICATIONS).toBe('0');
    expect(parsed.env.staging.vars.MEDICATIONS).toBe('0');
  });
});

describe('BROWSER_FORM_SUBMIT in the Worker config', () => {
  it('is on in staging for the Google Forms run, and off in production', () => {
    expect(parsed.vars.BROWSER_FORM_SUBMIT).toBe('0');
    expect(parsed.env.staging.vars.BROWSER_FORM_SUBMIT).toBe('1');
  });
});

describe('WALDO_RECALL_CHAIN in the Worker config', () => {
  it('is off in production and on in staging', () => {
    expect(parsed.vars.WALDO_RECALL_CHAIN).toBe('0');
    expect(parsed.env.staging.vars.WALDO_RECALL_CHAIN).toBe('1');
  });
});

describe('WALDO_FILE_TOOLS in the Worker config', () => {
  it('is off in production and on in staging', () => {
    expect(parsed.vars.WALDO_FILE_TOOLS).toBe('0');
    expect(parsed.env.staging.vars.WALDO_FILE_TOOLS).toBe('1');
  });
});

describe('PLANNING_BRIEF in the Worker config', () => {
  it('is off in production until a judged planning Brief passes, and on in staging', () => {
    expect(parsed.vars.PLANNING_BRIEF).toBe('0');
    expect(parsed.env.staging.vars.PLANNING_BRIEF).toBe('1');
  });
});

describe('SCREEN_TIME in the Worker config', () => {
  it('is on in staging, where migration 20261103120000 is applied (4 Nov 2026), and off in production', () => {
    expect(parsed.vars.SCREEN_TIME).toBe('0');
    expect(parsed.env.staging.vars.SCREEN_TIME).toBe('1');
  });
});

describe('DEVICE_PLACE in the Worker config', () => {
  it('is off in production and on in staging, where the deploy applies migration 20261105180000 first', () => {
    expect(parsed.vars.DEVICE_PLACE).toBe('0');
    expect(parsed.env.staging.vars.DEVICE_PLACE).toBe('1');
  });
});

describe('CAPACITY_PLAN in the Worker config', () => {
  it('is on for staging and off for production', () => {
    expect(parsed.vars.CAPACITY_PLAN).toBe('0');
    expect(parsed.env.staging.vars.CAPACITY_PLAN).toBe('1');
  });
});

describe('TOMORROW_TODAY in the Worker config', () => {
  it('is on for staging and off for production', () => {
    expect(parsed.vars.TOMORROW_TODAY).toBe('0');
    expect(parsed.env.staging.vars.TOMORROW_TODAY).toBe('1');
  });
});

describe('CAPACITY_BUDGET in the Worker config', () => {
  it('is on for staging and off for production', () => {
    expect(parsed.vars.CAPACITY_BUDGET).toBe('0');
    expect(parsed.env.staging.vars.CAPACITY_BUDGET).toBe('1');
  });
});
