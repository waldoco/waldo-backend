export type MedicalClaimDecision =
  | { ok: true }
  | { ok: false; reason: 'medical_claim' };

const FORBIDDEN_CONDITION = /\b(?:anxiety|depression|atrial fibrillation|afib|sleep apnea|hypertension|diabetes|heart disease|hypoxia|tachycardia)\b/i;
const DIAGNOSIS_OR_RISK = /\b(?:you (?:have|may have|might have|are at risk(?: for)?|are stressed)|(?:data|reading|readings|pulse|hrv|sleep|blood pressure|glucose)\s+(?:shows?|proves?|means?|indicates?|suggests?)\s+(?:that\s+)?(?:you\s+)?(?:have|a\s+medical|a\s+condition|disease))\b/i;
const DIRECT_TREATMENT = /\b(?:you should|you need to|start|stop|increase|decrease|take|avoid taking)\s+(?:taking\s+)?(?:(?:a|an|your|prescribed)\s+){0,3}(?:medication|medicine|aspirin|melatonin|magnesium|adaptogen|supplement|treatment|therapy|prescription)\b/i;
const DOSAGE = /\b(?:take|start|increase|decrease|use)\b[^.!?]{0,40}\b\d+(?:\.\d+)?\s*(?:mcg|mg|g|ml|tablets?|capsules?|doses?)\b/i;
const PRESCRIPTIVE_HEALTH = /\b(?:prescribe|prescribed dosage|medical diagnosis|diagnose[ds]?)\b/i;
const SYMPTOM_INTERPRETATION = /\b(?:your|these)\s+(?:symptoms?|readings?|data|numbers?)\b[^.!?]{0,50}\b(?:indicate|mean|show|suggest|prove)s?\b[^.!?]{0,50}\b(?:illness|disease|condition|infection|disorder)\b/i;
const GENERIC_DIAGNOSIS = /\byou\s+(?:have|may have|might have|could have)\s+(?:[a-z-]+\s+){0,3}(?:disease|syndrome|disorder|condition|infection|cancer)\b/i;
const COMMON_TREATMENT = /\b(?:take|start taking|stop taking|increase|decrease)\s+(?:your\s+)?(?:ibuprofen|acetaminophen|paracetamol|vitamin\s+[a-z0-9]+|creatine|ashwagandha|[a-z]+(?:pril|olol|statin|cillin|cycline))\b/i;

export function evaluateMedicalClaim(text: string): MedicalClaimDecision {
  if (
    FORBIDDEN_CONDITION.test(text) ||
    DIAGNOSIS_OR_RISK.test(text) ||
    DIRECT_TREATMENT.test(text) ||
    DOSAGE.test(text) ||
    PRESCRIPTIVE_HEALTH.test(text) ||
    SYMPTOM_INTERPRETATION.test(text) ||
    GENERIC_DIAGNOSIS.test(text) ||
    COMMON_TREATMENT.test(text)
  ) {
    return { ok: false, reason: 'medical_claim' };
  }
  return { ok: true };
}
