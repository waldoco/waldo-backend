import type { GeneralRequestBody } from './general-browser-redirects';

// The form an element belongs to, read by host-authored page code. Its fields are the exact name/value pairs an owner
// approval admits on the wire; its answers are what the owner's card shows. Page content is evidence, never authority.
export type GeneralFormAnswer = Readonly<{ label: string; value: string }>;
export type GeneralFormSubmission = Readonly<{
  method: string; action: string; enctype: string;
  fields: readonly (readonly [string, string])[];
  answers: readonly GeneralFormAnswer[];
  file: boolean; secret: boolean;
}>;

export const FORM_SUBMIT_LIMITS = Object.freeze({ fields: 300, bodyBytes: 32 * 1024, answers: 60, label: 200, value: 500 });

// Runs inside the page. Kept self-contained with no named inner functions: esbuild's keepNames transform would make
// them reference a host-only helper.
export function generalFormSubmission(node: any): GeneralFormSubmission | null {
  const root: any = globalThis;
  const form = node.form ?? node.closest?.('form');
  if (!form) return null;
  const fields: [string, string][] = [];
  let file = false;
  for (const [name, value] of new root.FormData(form)) {
    if (typeof value === 'string') fields.push([String(name), value]); else file = true;
  }
  const secret = Boolean(form.querySelector('input[type="password"],input[autocomplete~="one-time-code" i],textarea[autocomplete~="one-time-code" i]'));
  const answers: { label: string; value: string }[] = [];
  for (const control of Array.from(form.querySelectorAll('input,textarea,select,[role="radio"],[role="checkbox"],[role="option"],[role="switch"]')) as any[]) {
    const box = control.getBoundingClientRect(), style = root.getComputedStyle(control);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none') continue;
    const tag = String(control.tagName).toLowerCase(), type = String(control.type ?? '').toLowerCase(), role = String(control.getAttribute('role') ?? '');
    const own = control.labels ? Array.from(control.labels).map((label: any) => String(label.innerText ?? '')).join(' ') : '';
    const named = String(control.getAttribute('aria-label') ?? '') || own;
    let value = '';
    if (tag === 'select') value = Array.from(control.selectedOptions ?? []).map((option: any) => String(option.label || option.text || option.value)).join(', ');
    else if (tag === 'textarea' || tag === 'input' && !['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'checkbox', 'radio'].includes(type)) value = String(control.value ?? '');
    else if (tag === 'input' && (type === 'checkbox' || type === 'radio')) value = control.checked ? named || String(control.value ?? '') : '';
    else if (role && (control.getAttribute('aria-checked') === 'true' || control.getAttribute('aria-selected') === 'true')) value = named || String(control.getAttribute('data-value') ?? '') || String(control.innerText ?? '');
    value = value.trim();
    if (!value) continue;
    const group = control.closest('[role="listitem"],fieldset,[role="radiogroup"],[role="group"]');
    const heading = group?.querySelector('[role="heading"],legend');
    const label = String(heading?.innerText ?? heading?.textContent ?? '').trim() || (tag === 'input' && (type === 'checkbox' || type === 'radio') || role ? '' : named.trim()) || String(control.getAttribute('name') ?? control.getAttribute('placeholder') ?? '').trim() || 'Answer';
    answers.push({ label, value });
  }
  return { method: String(form.method ?? '').toLowerCase(), action: String(form.action ?? ''), enctype: String(form.enctype ?? '').toLowerCase(), fields, answers, file, secret };
}

const pairs = (value: unknown): value is readonly (readonly [string, string])[] =>
  Array.isArray(value) && value.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string');

// What the page answered, checked before any of it reaches the owner's card or a permit.
export function parseGeneralFormSubmission(value: unknown): GeneralFormSubmission | null {
  if (!value || typeof value !== 'object') return null;
  const form = value as Record<string, unknown>;
  if (typeof form.method !== 'string' || typeof form.action !== 'string' || typeof form.enctype !== 'string' || typeof form.file !== 'boolean' || typeof form.secret !== 'boolean' || !pairs(form.fields)
    || !Array.isArray(form.answers) || !form.answers.every(answer => answer && typeof answer === 'object' && typeof (answer as GeneralFormAnswer).label === 'string' && typeof (answer as GeneralFormAnswer).value === 'string')) return null;
  return { method: form.method, action: form.action, enctype: form.enctype, file: form.file, secret: form.secret, fields: form.fields.map(([name, item]) => [name, item] as const),
    answers: (form.answers as GeneralFormAnswer[]).map(answer => ({ label: answer.label.slice(0, FORM_SUBMIT_LIMITS.label), value: answer.value.slice(0, FORM_SUBMIT_LIMITS.value) })) };
}

export const encodedFormBytes = (fields: readonly (readonly [string, string])[]) => new TextEncoder().encode(new URLSearchParams(fields.map(([name, value]): [string, string] => [name, value])).toString()).byteLength;

// The request an approval admits: an urlencoded body that carries every approved field with exactly its approved values.
// The page may add fields it generates at send time (a token, a timestamp); it may not change or drop an approved one.
export function formBodyMatches(approved: readonly (readonly [string, string])[], body: GeneralRequestBody | undefined): boolean {
  if (!body || body.data === null || !/^application\/x-www-form-urlencoded(\s*;.*)?$/i.test(body.contentType ?? '')) return false;
  const sent = new Map<string, string[]>(), wanted = new Map<string, string[]>();
  for (const [name, value] of new URLSearchParams(body.data)) sent.set(name, [...sent.get(name) ?? [], value]);
  for (const [name, value] of approved) wanted.set(name, [...wanted.get(name) ?? [], value]);
  for (const [name, values] of wanted) {
    const got = [...sent.get(name) ?? []].sort(), expected = [...values].sort();
    if (got.length !== expected.length || got.some((value, index) => value !== expected[index])) return false;
  }
  return true;
}
