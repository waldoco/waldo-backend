import { z } from 'zod';
import { channelNameSchema } from '../adapters/channel';
import { QUICK_REPLY_MAX_CHOICES, REPLY_FALLBACK_MAX_CHARS, REPLY_TEXT_MAX_CHARS } from './reply-parts';

// Messaging surfaces take their literals from the channel vocabulary (ADR-0012); app and console
// are the first-party session surfaces.
const MESSAGING_SURFACES = ['telegram', 'whatsapp', 'imessage'] as const;
export const messagingSurfaceV1Schema = channelNameSchema.extract(MESSAGING_SURFACES);
export const surfaceNameV1Schema = z.enum(['app', ...MESSAGING_SURFACES, 'console']);

// A renderer never emits an affordance these deny; it degrades to the part's fallback_text.
export const surfaceCapabilitiesV1Schema = z.strictObject({
  surface: surfaceNameV1Schema,
  approval: z.enum(['native', 'buttons', 'numbered', 'none']),
  quick_replies: z.enum(['chips', 'buttons', 'numbered', 'none']),
  max_buttons: z.int().min(0).max(QUICK_REPLY_MAX_CHOICES),
  charts: z.enum(['native', 'image', 'alt_text']),
  files: z.boolean(),
  voice: z.boolean(),
  threads: z.boolean(),
  max_text_chars: z.int().min(REPLY_FALLBACK_MAX_CHARS).max(REPLY_TEXT_MAX_CHARS),
});

export type SurfaceNameV1 = z.infer<typeof surfaceNameV1Schema>;
export type SurfaceCapabilitiesV1 = z.infer<typeof surfaceCapabilitiesV1Schema>;

// Declares only what each surface renders today: the console shows approvals but no chat parts,
// and messaging charts stay alt text until a rasterizer is chosen.
export const SURFACE_CAPABILITIES_V1 = {
  app: { surface: 'app', approval: 'native', quick_replies: 'chips', max_buttons: QUICK_REPLY_MAX_CHOICES, charts: 'native', files: true, voice: true, threads: true, max_text_chars: REPLY_TEXT_MAX_CHARS },
  telegram: { surface: 'telegram', approval: 'buttons', quick_replies: 'buttons', max_buttons: QUICK_REPLY_MAX_CHOICES, charts: 'alt_text', files: true, voice: true, threads: false, max_text_chars: 4_096 },
  whatsapp: { surface: 'whatsapp', approval: 'buttons', quick_replies: 'buttons', max_buttons: 3, charts: 'alt_text', files: true, voice: true, threads: false, max_text_chars: 4_096 },
  imessage: { surface: 'imessage', approval: 'numbered', quick_replies: 'numbered', max_buttons: 0, charts: 'alt_text', files: true, voice: true, threads: false, max_text_chars: 4_096 },
  console: { surface: 'console', approval: 'native', quick_replies: 'none', max_buttons: 3, charts: 'alt_text', files: false, voice: false, threads: true, max_text_chars: REPLY_TEXT_MAX_CHARS },
} as const satisfies Readonly<{ [S in SurfaceNameV1]: SurfaceCapabilitiesV1 & { surface: S } }>;
