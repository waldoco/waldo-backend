import { describe, expect, it } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { flatConfig } from '../../../scripts/wrangler-vars.mjs';

// The health and device switches still declared, each with its staging and production values, so a merge that takes one side
// of the vars line cannot silently revert them.
type Vars = Readonly<Record<string, string>>;
const parsed = flatConfig(parseJsonc(config)) as { vars: Vars; env: { staging: { vars: Vars } } };

describe('the Worker config', () => {
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

describe('HEALTH_FORM_CURVE in the Worker config', () => {
  it('is declared off for staging and production, until the privacy review ADR-0081 asks for has passed', () => {
    expect(parsed.vars.HEALTH_FORM_CURVE).toBe('0');
    expect(parsed.env.staging.vars.HEALTH_FORM_CURVE).toBe('0');
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
  // The owner turned it on for staging only; the staging deploy that carries it must have migration 20261101040000 applied.
  it('is on in staging only, and off in production', () => {
    expect(parsed.vars.MEDICATIONS).toBe('0');
    expect(parsed.env.staging.vars.MEDICATIONS).toBe('1');
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

describe('WAKE_BRIEF, BRIEF_DAY_PLAN and CALENDAR_PLAN in the Worker config', () => {
  it('are off in production and on in staging, with the wake limits declared in both', () => {
    for (const name of ['WAKE_BRIEF', 'BRIEF_DAY_PLAN', 'CALENDAR_PLAN']) expect([name, parsed.vars[name], parsed.env.staging.vars[name]]).toEqual([name, '0', '1']);
    for (const vars of [parsed.vars, parsed.env.staging.vars]) expect([vars.WAKE_BRIEF_FRESH_MIN, vars.WAKE_BRIEF_TURNS_PER_DAY]).toEqual(['180', '3']);
  });
});

describe('DEVICE_PLACE in the Worker config', () => {
  it('is off in production and on in staging, where the deploy applies migration 20261105180000 first', () => {
    expect(parsed.vars.DEVICE_PLACE).toBe('0');
    expect(parsed.env.staging.vars.DEVICE_PLACE).toBe('1');
  });
});

describe('DEVICE_CALENDAR in the Worker config', () => {
  it('is off in production and on in staging; it needs no migration: the owner object keeps the consent and the events', () => {
    expect(parsed.vars.DEVICE_CALENDAR).toBe('0');
    expect(parsed.env.staging.vars.DEVICE_CALENDAR).toBe('1');
  });
});

describe('CALENDAR_COVERAGE and FREE_WINDOW_OFFERS in the Worker config', () => {
  it('are off in production and on in staging; neither needs a migration', () => {
    expect([parsed.vars.CALENDAR_COVERAGE, parsed.vars.FREE_WINDOW_OFFERS]).toEqual(['0', '0']);
    expect([parsed.env.staging.vars.CALENDAR_COVERAGE, parsed.env.staging.vars.FREE_WINDOW_OFFERS]).toEqual(['1', '1']);
  });
});

describe('BLOCK_LIFECYCLE in the Worker config', () => {
  it('is off in production and on in staging; it needs no migration', () => {
    expect(parsed.vars.BLOCK_LIFECYCLE).toBe('0');
    expect(parsed.env.staging.vars.BLOCK_LIFECYCLE).toBe('1');
  });
});

describe('ARRIVAL_LOOK in the Worker config', () => {
  it('is off in production and on in staging, where the deploy applies migration 20261107100000 first', () => {
    expect(parsed.vars.ARRIVAL_LOOK).toBe('0');
    expect(parsed.env.staging.vars.ARRIVAL_LOOK).toBe('1');
  });
});

describe('DEVICE_WEATHER in the Worker config', () => {
  it('is off in production and on in staging, where it offers get_weather only once the WeatherKit secrets are set', () => {
    expect(parsed.vars.DEVICE_WEATHER).toBe('0');
    expect(parsed.env.staging.vars.DEVICE_WEATHER).toBe('1');
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
