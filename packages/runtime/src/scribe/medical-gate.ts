// Hard line only: medication, supplement and dose instructions. Diagnosis, risk and
// state-labeling are judgment calls the model makes under the messaging prompt.
export type MedicalClaimDecision =
  | { ok: true }
  | { ok: false; reason: 'medical_claim' };

const DIRECT_TREATMENT = /\b(?:you should|you need to|start|stop|increase|decrease|take|avoid taking)\s+(?:taking\s+)?(?:(?:a|an|your|prescribed)\s+){0,3}(?:medication|medicine|aspirin|melatonin|magnesium|adaptogen|supplement|treatment|therapy|prescription)\b/i;
const DOSAGE = /\b(?:take|start|increase|decrease|use|inject|administer)\b[^.!?]{0,40}(?:\b\d+(?:\.\d*)?|(?<!\d)\.\d+)\s*(?:-\s*)?(?:mcg|mg|g|ml|u|iu|units?|tablets?|capsules?|doses?)\b/i;
const WORD_NUMBER_DOSAGE = /\b(?:take|start|increase|decrease|use|inject|administer)\b[^.!?]{0,40}\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s+(?:u|iu|international units?|units?|tablets?|capsules?|doses?)\b/i;
const COMMON_TREATMENT = /\b(?:take|start taking|begin taking|stop taking|increase|decrease)\s+(?:(?:a|an|your)\s+){0,2}(?:prescription\s+)?(?:drug|metformin|tylenol|ibuprofen|acetaminophen|paracetamol|vitamin\s+[a-z0-9]+|creatine|ashwagandha|[a-z]+(?:pril|olol|statin|cillin|cycline))\b/i;
const DIRECT_SUBSTANCE_INSTRUCTION = /\b(?:take|start(?: taking)?|begin(?: taking)?|stop(?: taking)?)\s+(?:(?:a|an|your|prescribed)\s+){0,2}(?!(?:(?:a|an|your|the|my)\s+)?(?:(?:short|brief|deep|quick|light|new)\s+)?(?:walk|break|breath|rest|nap|moment|time|shower|step|workout|exercise|training|run|stretch|routine|session|warm-?up|meditation|gym|yoga|day|morning|evening|plan|habit|reminder|[a-z]+ing)\b|it|things|care)\b[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*){0,2}\s+(?:now|today|tonight|daily|immediately)\b/i;
const WORD_DOSAGE = /\b(?:take|start|increase|decrease|use|inject|administer)\b[^.!?]{0,40}(?:\b\d+(?:\.\d*)?|(?<!\d)\.\d+)\s*(?:milligrams?|micrograms?|grams?|milliliters?|international units?|units?)\b/i;
const DIRECT_DOSE_CHANGE = /\b(?:double|halve)\s+(?:your\s+)?(?:insulin|medication|medicine|dose|dosage|prescription)\b/i;
const FRACTIONAL_DOSAGE = /\b(?:take|start|increase|decrease|use|inject|administer)\b[^.!?]{0,40}(?:(?:\b(?:\d+\s*\/\s*\d+|one[-\s](?:half|quarter)|half|quarter))|[¼½¾])\s*(?:(?:of\s+)?(?:a|an)\s+)?(?:mcg|mg|g|ml|u|iu|units?|tablets?|capsules?|doses?)\b/i;

export function evaluateMedicalClaim(text: string): MedicalClaimDecision {
  if (
    DIRECT_TREATMENT.test(text) ||
    DOSAGE.test(text) ||
    WORD_NUMBER_DOSAGE.test(text) ||
    COMMON_TREATMENT.test(text) ||
    DIRECT_SUBSTANCE_INSTRUCTION.test(text) ||
    WORD_DOSAGE.test(text) ||
    DIRECT_DOSE_CHANGE.test(text) ||
    FRACTIONAL_DOSAGE.test(text)
  ) {
    return { ok: false, reason: 'medical_claim' };
  }
  return { ok: true };
}
