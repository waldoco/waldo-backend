import { describe, expect, it } from 'vitest';
import config from '../wrangler.jsonc?raw';
import { parseJsonc } from '../../../scripts/jsonc.mjs';
import { flatConfig } from '../../../scripts/wrangler-vars.mjs';

// Production runs staging's switches except the ones kept off there (medicines, browser form submits, the owner look-up). Each
// value is asserted on both sides, so a merge that takes one side of the vars line cannot silently revert it.
type Vars = Readonly<Record<string, string>>;
const parsed = flatConfig(parseJsonc(config)) as { vars: Vars; env: { staging: { vars: Vars } } };

describe('HEALTH_PROVISIONAL_SCORES in the Worker config', () => {
  it('is on in production and in staging', () => {
    expect(parsed.vars.HEALTH_PROVISIONAL_SCORES).toBe('1');
    expect(parsed.env.staging.vars.HEALTH_PROVISIONAL_SCORES).toBe('1');
  });
  it('leaves the staging vars the gate turned on as they are', () => {
    expect(parsed.env.staging.vars.APP_AGREEMENTS).toBe('1');
    expect(parsed.env.staging.vars.OWNER_LOOKUP).toBe('1');
    expect(parsed.env.staging.vars.WHATSAPP_DEBUG_LOG).toBe('false');
  });
  it('keeps production\'s owner look-up and WhatsApp debug log off, with agreements on as in staging', () => {
    expect(parsed.vars.APP_AGREEMENTS).toBe('1');
    expect(parsed.vars.OWNER_LOOKUP).toBe('0');
    expect(parsed.vars.WHATSAPP_DEBUG_LOG).toBe('false');
  });
});

describe('HEALTH_SOLO_NOTICE in the Worker config', () => {
  it('is on in production and in staging', () => {
    expect(parsed.vars.HEALTH_SOLO_NOTICE).toBe('1');
    expect(parsed.env.staging.vars.HEALTH_SOLO_NOTICE).toBe('1');
  });
});

describe('HEALTH_FORM_CURVE in the Worker config', () => {
  it('is declared off for staging and production, until the privacy review ADR-0081 asks for has passed', () => {
    expect(parsed.vars.HEALTH_FORM_CURVE).toBe('0');
    expect(parsed.env.staging.vars.HEALTH_FORM_CURVE).toBe('0');
  });
});

describe('HEALTH_TRAINING_LOAD in the Worker config', () => {
  it('is on in production and in staging, each deployed with migration 20261031170000', () => {
    expect(parsed.vars.HEALTH_TRAINING_LOAD).toBe('1');
    expect(parsed.env.staging.vars.HEALTH_TRAINING_LOAD).toBe('1');
  });
});

describe('HEALTH_COACHING in the Worker config', () => {
  it('is on in production and in staging, each deployed with migrations 20261101000000 and 20261101020000', () => {
    expect(parsed.vars.HEALTH_COACHING).toBe('1');
    expect(parsed.env.staging.vars.HEALTH_COACHING).toBe('1');
  });
});

describe('HEALTH_EASE_WORKOUT in the Worker config', () => {
  it('is on in production and in staging, each running the redeployed connector-proxy function', () => {
    expect(parsed.vars.HEALTH_EASE_WORKOUT).toBe('1');
    expect(parsed.env.staging.vars.HEALTH_EASE_WORKOUT).toBe('1');
  });
});

describe('CALENDAR_UNDO_CANCEL in the Worker config', () => {
  it('is on in production and in staging, each running the redeployed connector-proxy function', () => {
    expect(parsed.vars.CALENDAR_UNDO_CANCEL).toBe('1');
    expect(parsed.env.staging.vars.CALENDAR_UNDO_CANCEL).toBe('1');
  });
});

describe('WHY_TRAIL in the Worker config', () => {
  it('is on in production and in staging', () => {
    expect(parsed.vars.WHY_TRAIL).toBe('1');
    expect(parsed.env.staging.vars.WHY_TRAIL).toBe('1');
  });
});

describe('HISTORY_ARCHIVE in the Worker config', () => {
  it('counts only (dry) in production and in staging', () => {
    expect(parsed.vars.HISTORY_ARCHIVE).toBe('dry');
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
  it('is on in production and in staging', () => {
    expect(parsed.vars.WALDO_RECALL_CHAIN).toBe('1');
    expect(parsed.env.staging.vars.WALDO_RECALL_CHAIN).toBe('1');
  });
});

describe('WALDO_FILE_TOOLS in the Worker config', () => {
  it('is on in production and in staging', () => {
    expect(parsed.vars.WALDO_FILE_TOOLS).toBe('1');
    expect(parsed.env.staging.vars.WALDO_FILE_TOOLS).toBe('1');
  });
});

describe('PLANNING_BRIEF in the Worker config', () => {
  it('is on in production and in staging', () => {
    expect(parsed.vars.PLANNING_BRIEF).toBe('1');
    expect(parsed.env.staging.vars.PLANNING_BRIEF).toBe('1');
  });
});

describe('WAKE_BRIEF, BRIEF_DAY_PLAN and CALENDAR_PLAN in the Worker config', () => {
  it('are on in production and in staging, with the wake limits declared in both', () => {
    for (const name of ['WAKE_BRIEF', 'BRIEF_DAY_PLAN', 'CALENDAR_PLAN']) expect([name, parsed.vars[name], parsed.env.staging.vars[name]]).toEqual([name, '1', '1']);
    for (const vars of [parsed.vars, parsed.env.staging.vars]) expect([vars.WAKE_BRIEF_FRESH_MIN, vars.WAKE_BRIEF_TURNS_PER_DAY]).toEqual(['180', '3']);
  });
});

describe('WORKOUT_WAKE in the Worker config', () => {
  it('is on in production and in staging', () => {
    expect([parsed.vars.WORKOUT_WAKE, parsed.env.staging.vars.WORKOUT_WAKE]).toEqual(['1', '1']);
  });
});

describe('HEALTH_PASSIVE_LOAD in the Worker config', () => {
  it('lists the phone sources whose cadence is known in production and in staging, where it acts only once HEALTH_DAY_LOAD is on', () => {
    expect(parsed.vars.HEALTH_PASSIVE_LOAD).toBe('apple,health_connect');
    expect(parsed.env.staging.vars.HEALTH_PASSIVE_LOAD).toBe('apple,health_connect');
  });
});

describe('HEALTH_DAY_LOAD and HEALTH_STRESS_CURVE in the Worker config', () => {
  it('keeps the day load on in production and in staging, each deployed with migration 20261116110000', () => {
    expect([parsed.vars.HEALTH_DAY_LOAD, parsed.env.staging.vars.HEALTH_DAY_LOAD]).toEqual(['1', '1']);
  });
  it('keeps the stress curve on in production and in staging, each deployed with migration 20261116110100', () => {
    expect([parsed.vars.HEALTH_STRESS_CURVE, parsed.env.staging.vars.HEALTH_STRESS_CURVE]).toEqual(['1', '1']);
  });
});

describe('HEALTH_SCORE_PARTS and HEALTH_USUAL in the Worker config', () => {
  it('are on in production and in staging, each deployed with migration 20261116100000', () => {
    for (const name of ['HEALTH_SCORE_PARTS', 'HEALTH_USUAL']) {
      expect(parsed.vars[name], name).toBe('1');
      expect(parsed.env.staging.vars[name], name).toBe('1');
    }
  });
});

describe('SCREEN_TIME in the Worker config', () => {
  it('is on in production and in staging, each deployed with migration 20261103120000', () => {
    expect(parsed.vars.SCREEN_TIME).toBe('1');
    expect(parsed.env.staging.vars.SCREEN_TIME).toBe('1');
  });
});

describe('DEVICE_PLACE in the Worker config', () => {
  it('is on in production and in staging, where the deploy applies migration 20261105180000 first', () => {
    expect(parsed.vars.DEVICE_PLACE).toBe('1');
    expect(parsed.env.staging.vars.DEVICE_PLACE).toBe('1');
  });
});

describe('DEVICE_CALENDAR in the Worker config', () => {
  it('is on in production and in staging; it needs no migration: the owner object keeps the consent and the events', () => {
    expect(parsed.vars.DEVICE_CALENDAR).toBe('1');
    expect(parsed.env.staging.vars.DEVICE_CALENDAR).toBe('1');
  });
});

describe('CALENDAR_COVERAGE and FREE_WINDOW_OFFERS in the Worker config', () => {
  it('are on in production and in staging; neither needs a migration', () => {
    expect([parsed.vars.CALENDAR_COVERAGE, parsed.vars.FREE_WINDOW_OFFERS]).toEqual(['1', '1']);
    expect([parsed.env.staging.vars.CALENDAR_COVERAGE, parsed.env.staging.vars.FREE_WINDOW_OFFERS]).toEqual(['1', '1']);
  });
});

describe('BLOCK_LIFECYCLE in the Worker config', () => {
  it('is on in production and in staging; it needs no migration', () => {
    expect(parsed.vars.BLOCK_LIFECYCLE).toBe('1');
    expect(parsed.env.staging.vars.BLOCK_LIFECYCLE).toBe('1');
  });
});

describe('ARRIVAL_LOOK in the Worker config', () => {
  it('is on in production and in staging, where the deploy applies migration 20261107100000 first', () => {
    expect(parsed.vars.ARRIVAL_LOOK).toBe('1');
    expect(parsed.env.staging.vars.ARRIVAL_LOOK).toBe('1');
  });
});

describe('DEVICE_WEATHER in the Worker config', () => {
  it('is on in production and in staging, where it offers get_weather only once the WeatherKit secrets are set', () => {
    expect(parsed.vars.DEVICE_WEATHER).toBe('1');
    expect(parsed.env.staging.vars.DEVICE_WEATHER).toBe('1');
  });
});

describe('CAPACITY_PLAN in the Worker config', () => {
  it('is on in production and in staging', () => {
    expect(parsed.vars.CAPACITY_PLAN).toBe('1');
    expect(parsed.env.staging.vars.CAPACITY_PLAN).toBe('1');
  });
});

describe('TOMORROW_TODAY in the Worker config', () => {
  it('is on in production and in staging', () => {
    expect(parsed.vars.TOMORROW_TODAY).toBe('1');
    expect(parsed.env.staging.vars.TOMORROW_TODAY).toBe('1');
  });
});

describe('CAPACITY_BUDGET in the Worker config', () => {
  it('is on in production and in staging', () => {
    expect(parsed.vars.CAPACITY_BUDGET).toBe('1');
    expect(parsed.env.staging.vars.CAPACITY_BUDGET).toBe('1');
  });
});
