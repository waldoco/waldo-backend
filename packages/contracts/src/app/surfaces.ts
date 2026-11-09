import { z } from 'zod';

// Messaging names stay inside the channel vocabulary (ADR-0012); a contracts test checks the subset.
// App and console are the first-party session surfaces.
const MESSAGING_SURFACES = ['telegram', 'whatsapp', 'imessage'] as const;
export const messagingSurfaceV1Schema = z.enum(MESSAGING_SURFACES);
export const surfaceNameV1Schema = z.enum(['app', ...MESSAGING_SURFACES, 'console']);

export type MessagingSurfaceV1 = z.infer<typeof messagingSurfaceV1Schema>;
export type SurfaceNameV1 = z.infer<typeof surfaceNameV1Schema>;
