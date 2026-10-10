import { describe, expect, it } from 'vitest';
import { channelNameSchema } from '../adapters/channel';
import * as appSurfaces from '../app/surfaces';
import { REPLY_FALLBACK_MAX_CHARS } from './reply-parts';
import {
  messagingSurfaceV1Schema,
  SURFACE_CAPABILITIES_V1,
  surfaceCapabilitiesV1Schema,
  surfaceNameV1Schema,
} from './surface-capabilities';

describe('surfaceNameV1', () => {
  it('is the first-party app and console plus messaging channels drawn from the channel vocabulary', () => {
    expect(surfaceNameV1Schema.options).toEqual(['app', 'telegram', 'whatsapp', 'imessage', 'console']);
    expect(surfaceNameV1Schema).toBe(appSurfaces.surfaceNameV1Schema);
    expect(messagingSurfaceV1Schema).toBe(appSurfaces.messagingSurfaceV1Schema);
    for (const channel of appSurfaces.messagingSurfaceV1Schema.options) expect(channelNameSchema.options).toContain(channel);
    expect(surfaceNameV1Schema.safeParse('in_app').success).toBe(false);
    expect(messagingSurfaceV1Schema.safeParse('app').success).toBe(false);
  });
});

describe('surfaceCapabilitiesV1', () => {
  it('declares one parseable capability set per surface, keyed by that surface', () => {
    expect(Object.keys(SURFACE_CAPABILITIES_V1).sort()).toEqual([...surfaceNameV1Schema.options].sort());
    for (const [surface, caps] of Object.entries(SURFACE_CAPABILITIES_V1)) {
      expect(surfaceCapabilitiesV1Schema.parse(caps).surface).toBe(surface);
    }
  });

  it('matches the omnipresence design table', () => {
    const { app, telegram, whatsapp, imessage, console: web } = SURFACE_CAPABILITIES_V1;
    expect([app.approval, app.quick_replies, app.charts, app.threads]).toEqual(['native', 'chips', 'native', true]);
    expect([telegram.approval, telegram.quick_replies, telegram.charts, telegram.threads, telegram.max_text_chars]).toEqual(['buttons', 'buttons', 'alt_text', false, 4096]);
    expect([whatsapp.approval, whatsapp.quick_replies, whatsapp.max_buttons, whatsapp.threads]).toEqual(['buttons', 'buttons', 3, false]);
    expect([imessage.approval, imessage.quick_replies, imessage.max_buttons, imessage.threads]).toEqual(['numbered', 'numbered', 0, false]);
    expect([web.approval, web.threads]).toEqual(['native', true]);
  });

  it('rejects unknown surfaces and modes, extra keys, and a text cap a fallback cannot fit', () => {
    const caps = SURFACE_CAPABILITIES_V1.telegram;
    expect(surfaceCapabilitiesV1Schema.safeParse({ ...caps, surface: 'sms' }).success).toBe(false);
    expect(surfaceCapabilitiesV1Schema.safeParse({ ...caps, approval: 'inline' }).success).toBe(false);
    expect(surfaceCapabilitiesV1Schema.safeParse({ ...caps, charts: 'svg' }).success).toBe(false);
    expect(surfaceCapabilitiesV1Schema.safeParse({ ...caps, max_buttons: 11 }).success).toBe(false);
    expect(surfaceCapabilitiesV1Schema.safeParse({ ...caps, max_text_chars: REPLY_FALLBACK_MAX_CHARS - 1 }).success).toBe(false);
    expect(surfaceCapabilitiesV1Schema.safeParse({ ...caps, ui_parts: true }).success).toBe(false);
  });
});
