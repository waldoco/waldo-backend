import type { ChannelKind, SurfaceModule } from '../owner-runtime';
import * as app from './app-runtime';
import * as imessage from './imessage';
import * as telegram from './telegram';
import * as whatsapp from './whatsapp';

// Every surface an owner runtime serves, by name. The one place the list is enumerated: the runtime looks a surface up
// here and reads what it declares, never which one it is.
export const SURFACES: Readonly<Record<ChannelKind, SurfaceModule>> = Object.freeze({
  telegram: { descriptor: telegram.telegramSurface, surfaceAdapter: telegram.surfaceAdapter },
  app: { descriptor: app.appSurface, surfaceAdapter: app.surfaceAdapter },
  imessage: { descriptor: imessage.imessageSurface, surfaceAdapter: imessage.surfaceAdapter },
  whatsapp: { descriptor: whatsapp.whatsappSurface, surfaceAdapter: whatsapp.surfaceAdapter },
});

export const isChannelKind = (name: string): name is ChannelKind => Object.hasOwn(SURFACES, name);
