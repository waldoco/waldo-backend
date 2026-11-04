import type { OwnerDO } from '../../src/channels/owner-do';

// Runs the owner's queued WhatsApp turns on the test's own instance, as its alarm pass does, and resolves once the inbox is
// empty. A turn admitted while one runs is taken by the same pass.
export const drainWhatsAppTurns = (instance: OwnerDO): Promise<void> => {
  const owner = instance as unknown as { serial(work: () => Promise<void>): Promise<void>; drainWhatsApp(): Promise<void> };
  return owner.serial(() => owner.drainWhatsApp());
};
