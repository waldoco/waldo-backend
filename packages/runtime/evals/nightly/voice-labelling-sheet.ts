// Prints the sheet the owner labels from: `pnpm --filter @waldo/runtime eval:voice-labelling-sheet > sheet.md`. No
// network, no keys, and none of the draft calls.
import { labellingSheet } from './owner-labels';
import { loadVoiceLabels } from './voice-labels';

console.log(labellingSheet(loadVoiceLabels()));
