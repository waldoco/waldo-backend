import { afterEach, describe, expect, it, vi } from 'vitest';
import { writesOnGet } from '../src/channels/public-web-policy';
import { formBodyMatches, generalFormSubmission, parseGeneralFormSubmission } from '../src/channels/general-browser-form';

describe('writesOnGet', () => {
  it('names Google Forms formResponse addresses, signed-in path included, and nothing else', () => {
    for (const url of ['https://docs.google.com/forms/d/e/fictional/formResponse', 'https://docs.google.com/forms/u/1/d/e/fictional/formResponse?entry.1=Yes', 'https://DOCS.google.com/forms/d/fictional/formResponse'])
      expect(writesOnGet(url), url).toBe(true);
    for (const url of ['https://docs.google.com/forms/d/e/fictional/viewform', 'https://docs.google.com/document/d/x/formResponse', 'https://example.com/forms/formResponse', 'not a url'])
      expect(writesOnGet(url), url).toBe(false);
  });
});

describe('formBodyMatches', () => {
  const approved = [['entry.1', 'Yes'], ['entry.2', 'Ana'], ['entry.3', 'red'], ['entry.3', 'blue']] as const;
  const urlencoded = (data: string) => ({ contentType: 'application/x-www-form-urlencoded;charset=UTF-8', data });
  it('admits the approved fields, in any order, with fields the page adds at send time', () => {
    expect(formBodyMatches(approved, urlencoded('entry.3=blue&entry.2=Ana&entry.1=Yes&entry.3=red&fbzx=-123&pageHistory=0'))).toBe(true);
  });
  it('refuses a changed, dropped or extra value of an approved field', () => {
    expect(formBodyMatches(approved, urlencoded('entry.1=No&entry.2=Ana&entry.3=red&entry.3=blue'))).toBe(false);
    expect(formBodyMatches(approved, urlencoded('entry.1=Yes&entry.3=red&entry.3=blue'))).toBe(false);
    expect(formBodyMatches(approved, urlencoded('entry.1=Yes&entry.2=Ana&entry.3=red&entry.3=blue&entry.3=green'))).toBe(false);
  });
  it('refuses any other encoding, and a request without a readable body', () => {
    expect(formBodyMatches(approved, { contentType: 'multipart/form-data; boundary=x', data: 'entry.1=Yes&entry.2=Ana&entry.3=red&entry.3=blue' })).toBe(false);
    expect(formBodyMatches(approved, { contentType: 'application/json', data: '{}' })).toBe(false);
    expect(formBodyMatches(approved, { contentType: 'application/x-www-form-urlencoded', data: null })).toBe(false);
    expect(formBodyMatches(approved, undefined)).toBe(false);
  });
});

describe('parseGeneralFormSubmission', () => {
  it('refuses a malformed page answer and clips long labels and values', () => {
    expect(parseGeneralFormSubmission(null)).toBeNull();
    expect(parseGeneralFormSubmission({ method: 'post', action: 'https://x.invalid', enctype: '', file: false, secret: false, fields: [['a']], answers: [] })).toBeNull();
    const parsed = parseGeneralFormSubmission({ method: 'post', action: 'https://x.invalid', enctype: '', file: false, secret: false, fields: [['a', 'b']], answers: [{ label: 'L'.repeat(900), value: 'V'.repeat(900) }] });
    expect([parsed?.answers[0]?.label.length, parsed?.answers[0]?.value.length]).toEqual([200, 500]);
  });
});

// A Google-Forms-shaped page: questions are list items with a heading, a choice is an ARIA radio whose value a hidden
// input carries, and text answers are native inputs. Every value is synthetic.
describe('generalFormSubmission', () => {
  afterEach(() => vi.unstubAllGlobals());
  const visible = { getBoundingClientRect: () => ({ width: 10, height: 10 }) };
  const element = (props: Record<string, unknown>, attributes: Record<string, string> = {}, group?: unknown) => ({ ...visible, labels: [], ...props, getAttribute: (name: string) => attributes[name] ?? null, closest: () => group ?? null });
  const question = (title: string) => ({ querySelector: () => ({ innerText: title }) });
  const page = (controls: unknown[], fields: [string, unknown][], secret = false) => {
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', display: 'block' }));
    vi.stubGlobal('FormData', class { constructor() { return fields as never; } });
    const form = { method: 'post', action: 'https://docs.google.com/forms/d/e/fictional/formResponse', enctype: 'application/x-www-form-urlencoded', querySelector: () => (secret ? {} : null), querySelectorAll: () => controls };
    return { closest: () => form };
  };
  it('reads the exact fields and the answers under each question title', () => {
    const attend = question('Will you attend?'), name = question('Your name');
    const submit = page([
      element({ tagName: 'DIV' }, { role: 'radio', 'aria-checked': 'true', 'aria-label': 'Yes' }, attend),
      element({ tagName: 'DIV' }, { role: 'radio', 'aria-checked': 'false', 'aria-label': 'No' }, attend),
      element({ tagName: 'INPUT', type: 'text', value: 'Ana' }, {}, name),
      element({ tagName: 'INPUT', type: 'hidden', value: 'Yes' }, {}, attend),
    ], [['entry.1', 'Yes'], ['entry.2', 'Ana'], ['fbzx', '-123']]);
    expect(generalFormSubmission(submit)).toEqual({ method: 'post', action: 'https://docs.google.com/forms/d/e/fictional/formResponse', enctype: 'application/x-www-form-urlencoded',
      fields: [['entry.1', 'Yes'], ['entry.2', 'Ana'], ['fbzx', '-123']], answers: [{ label: 'Will you attend?', value: 'Yes' }, { label: 'Your name', value: 'Ana' }], file: false, secret: false });
  });
  it('marks a file or a password field, and has nothing to say for a control outside a form', () => {
    const withFile = page([], [['upload', new Blob(['x'])]], true);
    expect(generalFormSubmission(withFile)).toMatchObject({ file: true, secret: true, fields: [] });
    expect(generalFormSubmission({ closest: () => null })).toBeNull();
  });
});
