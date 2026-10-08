import { parseBundledSkill } from './bundled-file';
import { BUNDLED_SKILL_FILES } from './bundled-text';

export const CURATED_PACK_SKILLS = Object.freeze(BUNDLED_SKILL_FILES.map(parseBundledSkill));
