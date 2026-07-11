export type MedicalClaimDecision =
  | { ok: true }
  | { ok: false; reason: 'medical_claim' };

const FORBIDDEN_CONDITION = /\b(?:anxiety|depression|atrial fibrillation|afib|sleep apnea|hypertension|diabetes|heart disease|hypoxia|tachycardia)\b/i;
const DIAGNOSIS_OR_RISK = /\b(?:you (?:have|may have|might have|are at risk(?: for)?|are stressed)|(?:data|reading|readings|pulse|hrv|sleep|blood pressure|glucose)\s+(?:shows?|proves?|means?|indicates?|suggests?)\s+(?:that\s+)?(?:you\s+)?(?:have|a\s+medical|a\s+condition|disease))\b/i;
const DIRECT_TREATMENT = /\b(?:you should|you need to|start|stop|increase|decrease|take|avoid taking)\s+(?:taking\s+)?(?:(?:a|an|your|prescribed)\s+){0,3}(?:medication|medicine|aspirin|melatonin|magnesium|adaptogen|supplement|treatment|therapy|prescription)\b/i;
const DOSAGE = /\b(?:take|start|increase|decrease|use|inject|administer)\b[^.!?]{0,40}\b\d+(?:\.\d+)?\s*(?:mcg|mg|g|ml|iu|units?|tablets?|capsules?|doses?)\b/i;
const PRESCRIPTIVE_HEALTH = /\b(?:prescribe|prescribed dosage|medical diagnosis|diagnose[ds]?)\b/i;
const SYMPTOM_INTERPRETATION = /\b(?:your|these)\s+(?:symptoms?|readings?|data|numbers?)\b[^.!?]{0,50}\b(?:indicate|mean|show|suggest|prove)s?\b[^.!?]{0,50}\b(?:illness|disease|condition|infection|disorder)\b/i;
const GENERIC_DIAGNOSIS = /\byou\s+(?:have|may have|might have|could have)\s+(?:[a-z-]+\s+){0,3}(?:disease|syndrome|disorder|condition|infection|cancer)\b/i;
const COMMON_TREATMENT = /\b(?:take|start taking|begin taking|stop taking|increase|decrease)\s+(?:(?:a|an|your)\s+){0,2}(?:prescription\s+)?(?:drug|metformin|tylenol|ibuprofen|acetaminophen|paracetamol|vitamin\s+[a-z0-9]+|creatine|ashwagandha|[a-z]+(?:pril|olol|statin|cillin|cycline))\b/i;
const DIRECT_SUBSTANCE_INSTRUCTION = /\b(?:take|start(?: taking)?|begin(?: taking)?|stop(?: taking)?)\s+(?:(?:a|an|your|prescribed)\s+){0,2}(?!(?:a\s+)?(?:(?:short|brief|deep)\s+)?(?:walk|break|breath|rest|nap|moment|time|shower|step)|it|things|care)\b[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*){0,2}\s+(?:now|today|tonight|daily|immediately)\b/i;
const IMMUTABLE_NEVER_CLAIM = /\b(?:this (?:is|may be|might be|could be) (?:a\s+)?symptom of|you should see (?:a|an|your)?\s*[a-z-]+(?:\s+[a-z-]+){0,2}\s+because|based on your data,?\s+you (?:(?:could|may|might) be|are)\s+at risk(?: for)?|your (?:hrv|heart rate|sleep|blood pressure|glucose) indicates?\s+[a-z-]+(?:\s+[a-z-]+){0,3})\b/i;
const WORD_DOSAGE = /\b(?:take|start|increase|decrease|use|inject|administer)\b[^.!?]{0,40}\b\d+(?:\.\d+)?\s*(?:milligrams?|micrograms?|grams?|milliliters?|international units?|units?)\b/i;
const DIRECT_DOSE_CHANGE = /\b(?:double|halve)\s+(?:your\s+)?(?:insulin|medication|medicine|dose|dosage|prescription)\b/i;

export function evaluateMedicalClaim(text: string): MedicalClaimDecision {
  if (
    FORBIDDEN_CONDITION.test(text) ||
    DIAGNOSIS_OR_RISK.test(text) ||
    DIRECT_TREATMENT.test(text) ||
    DOSAGE.test(text) ||
    PRESCRIPTIVE_HEALTH.test(text) ||
    SYMPTOM_INTERPRETATION.test(text) ||
    GENERIC_DIAGNOSIS.test(text) ||
    COMMON_TREATMENT.test(text) ||
    DIRECT_SUBSTANCE_INSTRUCTION.test(text) ||
    IMMUTABLE_NEVER_CLAIM.test(text) ||
    WORD_DOSAGE.test(text) ||
    DIRECT_DOSE_CHANGE.test(text)
  ) {
    return { ok: false, reason: 'medical_claim' };
  }
  return { ok: true };
}
