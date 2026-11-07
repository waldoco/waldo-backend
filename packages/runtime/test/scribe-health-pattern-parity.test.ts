// The numeric health patterns were rewritten so that no two repeats share a run of blanks and no gap word is tried at every
// split of a number's digits (see scribe-redos.test.ts). This holds the rewritten patterns to the ones they replaced: on
// text where a number is its own word, or follows a word ending in a letter, they find the same match in the same place.
// The one narrowing is meant: a number is no longer found by splitting its own digits ("form 1290" read "form 1" as a word
// and "290" as the score), so a four-digit figure after "form" is not a form score.
import { describe, expect, it } from 'vitest';
import { HEALTH_FREE_TEXT_NUMERIC } from '../src/scribe/sanitiser';

const BASE: readonly RegExp[] = [
  /\b(?:hrv|heart[\s_-]*rate(?:[\s_-]*variability)?|resting[\s_-]*heart[\s_-]*rate|pulse|spo2|oxygen[\s_-]*saturation|blood[\s_-]*oxygen|systolic|diastolic|blood[\s_-]*pressure|bp|body[\s_-]*(?:weight|mass)|weight|calorie[\s_-]*burn|calories[\s_-]*burned|active[\s_-]*energy|sleep(?:[\s_-]*(?:hours?|duration|minutes?|mins?))?|rem[\s_-]*sleep|deep[\s_-]*sleep|crs|form(?:[\s_-]*score)?|recovery(?:[\s_-]*score)?|load(?:[\s_-]*score)?)\b\s*,\s*["']?-?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?["']?\s*,\s*(?:ms|bpm|beats|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories|hours?|hrs?|minutes?|mins?)(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate(?:[\s_-]*variability)?|resting[\s_-]*heart[\s_-]*rate|pulse|spo2|oxygen[\s_-]*saturation|blood[\s_-]*oxygen|systolic|diastolic|body[\s_-]*(?:weight|mass)|calorie[\s_-]*burn|calories[\s_-]*burned|active[\s_-]*energy)\b(?:\s+\w+){0,3}?\s*(?:[:=,]\s*)?["']?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:ms|bpm|beats|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories)?(?=$|[^a-z0-9])/i,
  /\b(?:blood[\s_-]*pressure|bp)\b(?:\s+\w+){0,2}?\s*(?:[:=,]\s*)?["']?\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/i,
  /\b(?:blood[\s_-]*pressure|bp)\b(?:\s+\w+){0,2}?\s*(?:[:=,]\s*)?["']?\d+(?:\.\d+)?\s*mmhg\b/i,
  /\b(?:sleep|slept|rem[\s_-]*sleep|deep[\s_-]*sleep|time[\s_-]*asleep)\b(?:\s+\w+){0,3}?\s*(?:[:=,]\s*)?["']?\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/i,
  /\b(?:crs|form|recovery|load)(?:[\s_-]*score)?\b(?:\s+\w+){0,2}?\s*(?:[:=,]\s*)?["']?\d{1,3}\b/i,
  /\b(?:steps|step[\s_-]*count|motion|circadian|sleep[\s_-]*efficiency|sleep[\s_-]*stages?|body[\s_-]*temperature|respiratory[\s_-]*rate|breathing[\s_-]*rate|blood[\s_-]*glucose|glucose|provider[\s_-]*payload|health[\s_-]*payload|raw[\s_-]*payload)\b(?:\s+\w+){0,3}?\s*(?:[:=,]\s*)?["']?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:steps|percent|pct|%|minutes?|mins?|celsius|fahrenheit|breaths?(?:\s+per\s+minute)?|mg\/dl|mmol\/l)?(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate|spo2|blood[\s_-]*pressure|body[\s_-]*weight|steps|sleep[\s_-]*duration|body[\s_-]*temperature|respiratory[\s_-]*rate|glucose|crs|form|recovery|load)\b(?:\s+\w+){0,3}?\s*(?:[:=,]\s*)?["']?[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+["']?(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate|spo2|blood[\s_-]*pressure|body[\s_-]*(?:weight|temperature)|steps|sleep[\s_-]*(?:duration|efficiency)|respiratory[\s_-]*rate|glucose|crs|form|recovery|load)\b(?:\s+\w+){0,3}?\s*(?:[:=,]\s*)?["']?-?\d+(?:\.\d+)?["']?(?:\s*(?:,\s*)?)(?:°[cf]|degrees?\s*[cf])(?=$|[^a-z0-9])/i,
];

const KEYS = ['hrv', 'heart rate', 'steps', 'sleep duration', 'sleep', 'slept', 'bp', 'blood pressure', 'form', 'recovery', 'load', 'crs', 'glucose', 'spo2', 'body weight', 'resting heart rate', 'form score', 'respiratory rate'];
const WORDS = ['was', 'about', 'x', 'abc', 'duration', 'score', 'the', 'average', 'is', 'z', 'avg_', 'the_'];
const NUMBERS = ['12', '62', '140', '90', '140/90', '1.5', '98', '7', '6.5', '1e3', '2.5e2', '0.8', '55.2', '300'];
const AFTER = ['', 'ms', 'bpm', '%', 'mmhg', 'hours', 'hrs', 'mins', '°c', ' ms', ' bpm', ' %', ' mmhg', ' hours', ' degrees c', 'kg'];
const SEPS = ['', ':', '=', ',', ': ', ' = ', ', ', '"', ': "', "'"];

// Two patterns were widened afterwards: the HRV one takes the method in brackets ("hrv (rmssd) 45 ms") and the sleep one a
// short unit ("sleep 7h", "deep sleep 1h 20m") and a "~" before the number ("slept ~7h"), and two patterns were added at the
// end: a wrist temperature, and hours and minutes glued after a sleep word ("sleep 7h22"). A widened pattern still finds every
// match the earlier one found, where it found it, and may find more of the same text; the rest are as before.
const WIDENED = new Set([1, 4]);

describe('the rewritten numeric health patterns find what the ones they replaced found', () => {
  it('the same patterns, in the same order, then the wrist temperature and the glued sleep duration patterns', () => {
    expect(HEALTH_FREE_TEXT_NUMERIC).toHaveLength(BASE.length + 2);
    expect(HEALTH_FREE_TEXT_NUMERIC[BASE.length]!.source).toContain('wrist');
    expect(HEALTH_FREE_TEXT_NUMERIC[BASE.length + 1]!.source).toContain('h[0-5]');
  });

  it('over random text where numbers stand alone or follow a letter', () => {
    let state = 21;
    const pick = <T,>(items: readonly T[]): T => items[Math.floor((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296 * items.length)]!;
    let matched = 0;
    for (let run = 0; run < 20_000; run += 1) {
      let text = '';
      const parts = pick([1, 2, 3]);
      for (let part = 0; part < parts; part += 1) {
        text += `${pick(KEYS)}${pick([' ', ' ', '  ', '\n'])}`;
        const words = pick([0, 0, 1, 2, 3]);
        for (let word = 0; word < words; word += 1) text += `${pick(WORDS)} `;
        // A number is its own word, or follows letters directly ("abc12"): never the tail of a digit run.
        text += `${pick(SEPS)}${pick(['', '', pick(WORDS)])}${pick(NUMBERS)}${pick(AFTER)} `;
      }
      for (let at = 0; at < BASE.length; at += 1) {
        const before = BASE[at]!.exec(text), now = HEALTH_FREE_TEXT_NUMERIC[at]!.exec(text);
        if (before) matched += 1;
        if (WIDENED.has(at)) {
          if (before) expect([now?.index, now?.[0].startsWith(before[0])], `${JSON.stringify(text)} against pattern ${at}`).toEqual([before.index, true]);
        } else {
          expect([now?.[0], now?.index], `${JSON.stringify(text)} against pattern ${at}`).toEqual([before?.[0], before?.index]);
        }
      }
    }
    expect(matched).toBeGreaterThan(1_000);
  });

  it('a four-digit figure after form is no longer read as a score; a score still is', () => {
    const form = HEALTH_FREE_TEXT_NUMERIC.find(pattern => pattern.source.includes('crs|form|recovery|load'))!;
    expect(form.test('form 1290')).toBe(false);
    expect(form.test('form 129')).toBe(true);
    expect(form.test('recovery score: 82')).toBe(true);
  });
});
