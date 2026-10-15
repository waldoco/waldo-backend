import { z } from 'zod';
import { fallbackTextV1Schema, REPLY_FALLBACK_MAX_CHARS } from './parts';

// A view is structured content Waldo shows beside its words: options to compare, a table, steps or a timeline. The
// model chooses whether to show one and what it holds. The host bounds only size, and fits an oversized view to these
// bounds instead of refusing it: lists keep their first entries and long text is cut with an ellipsis.
export const VIEW_KINDS = ['options', 'table', 'steps', 'timeline'] as const;
export const VIEW_BOUNDS = {
  heading: 120, title: 160, subtitle: 200, detail: 600, label: 40, value: 160, cell: 200, when: 40, link: 2048,
  options: 10, facts: 6, columns: 8, rows: 50, steps: 20, timeline: 24,
} as const;
export const VIEW_STEP_STATES = ['done', 'current', 'todo'] as const;
// Shown to the owner to open, never fetched by the host.
export const VIEW_LINK_PATTERN = /^https:\/\/[^\s<>"]+$/;

type Strict = boolean;
const ONE_LINE = /^[^\n\r\u2028\u2029]*$/;
const words = (strict: Strict, max: number, oneLine = true) => {
  const text = z.string().regex(/\S/);
  return strict ? (oneLine ? text.max(max).regex(ONE_LINE) : text.max(max)) : text;
};
const list = <Item extends z.ZodType>(strict: Strict, item: Item, max: number) => strict ? z.array(item).min(1).max(max) : z.array(item).min(1);
const link = (strict: Strict) => strict ? z.string().max(VIEW_BOUNDS.link).regex(VIEW_LINK_PATTERN) : z.string();

const viewSchemaOf = (strict: Strict) => {
  const B = VIEW_BOUNDS;
  const heading = words(strict, B.heading).optional();
  return z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('options'), title: heading,
      items: list(strict, z.strictObject({
        title: words(strict, B.title), subtitle: words(strict, B.subtitle).optional(),
        facts: (strict ? z.array(z.strictObject({ label: words(strict, B.label), value: words(strict, B.value) })).max(B.facts)
          : z.array(z.strictObject({ label: words(strict, B.label), value: words(strict, B.value) }))).optional(),
        note: words(strict, B.detail, false).optional(), link: link(strict).optional(),
        // Waldo's pick among the options, when it has one.
        pick: z.boolean().optional(),
      }), B.options),
    }),
    z.strictObject({
      kind: z.literal('table'), title: heading,
      columns: list(strict, words(strict, B.label), B.columns),
      rows: list(strict, strict ? z.array(z.string().max(B.cell).regex(ONE_LINE)).max(B.columns) : z.array(z.string()), B.rows),
    }),
    z.strictObject({
      kind: z.literal('steps'), title: heading,
      items: list(strict, z.strictObject({ title: words(strict, B.title), detail: words(strict, B.detail, false).optional(), state: z.enum(VIEW_STEP_STATES).optional() }), B.steps),
    }),
    z.strictObject({
      kind: z.literal('timeline'), title: heading,
      items: list(strict, z.strictObject({ when: words(strict, B.when), title: words(strict, B.title), detail: words(strict, B.detail, false).optional() }), B.timeline),
    }),
  ]);
};

// What the model may send: the shape of a view, unbounded in size.
export const viewInputSchema = viewSchemaOf(false);
// What is stored and served: a view within its bounds, every table row as wide as its columns.
export const viewV1Schema = viewSchemaOf(true).refine(
  view => view.kind !== 'table' || view.rows.every(row => row.length === view.columns.length),
  { error: 'every row has one cell per column', path: ['rows'] },
);
export type ViewInput = z.infer<typeof viewInputSchema>;
export type ViewV1 = z.infer<typeof viewV1Schema>;

export const replyViewPartV1Schema = z.strictObject({ type: z.literal('view'), view: viewV1Schema, fallback_text: fallbackTextV1Schema });
export type ReplyViewPartV1 = z.infer<typeof replyViewPartV1Schema>;

// Every piece of owner-visible text in a view, rewritten by `text`, which is told the bound that applies to it (null for
// table cells, which may be empty). The one walker serves fitting and redaction, so neither can miss a field.
type Rewrite = (value: string, max: number, oneLine: boolean) => string;
export const mapViewText = <View extends ViewInput>(view: View, text: Rewrite): View => {
  const B = VIEW_BOUNDS;
  const put = (key: string, value: string | undefined, max: number, oneLine = true) => value === undefined ? {} : { [key]: text(value, max, oneLine) };
  const title = put('title', view.title, B.heading);
  switch (view.kind) {
    case 'options': return { ...view, ...title, items: view.items.map(item => ({
      ...item, title: text(item.title, B.title, true), ...put('subtitle', item.subtitle, B.subtitle), ...put('note', item.note, B.detail, false), ...put('link', item.link, B.link),
      ...(item.facts ? { facts: item.facts.map(fact => ({ label: text(fact.label, B.label, true), value: text(fact.value, B.value, true) })) } : {}),
    })) } as View;
    case 'table': return { ...view, ...title, columns: view.columns.map(column => text(column, B.label, true)), rows: view.rows.map(row => row.map(cell => text(cell, B.cell, true))) } as View;
    case 'steps': return { ...view, ...title, items: view.items.map(item => ({ ...item, title: text(item.title, B.title, true), ...put('detail', item.detail, B.detail, false) })) } as View;
    case 'timeline': return { ...view, ...title, items: view.items.map(item => ({ ...item, when: text(item.when, B.when, true), title: text(item.title, B.title, true), ...put('detail', item.detail, B.detail, false) })) } as View;
  }
};

// A link that cannot be opened as given is left off, never shortened or repaired.
const openable = (link: string) => link.length <= VIEW_BOUNDS.link && VIEW_LINK_PATTERN.test(link);
const withOpenableLinks = <View extends ViewInput>(view: View): View => view.kind !== 'options' ? view
  : { ...view, items: view.items.map(({ link, ...item }) => (link !== undefined && openable(link) ? { ...item, link } : item)) };

// Forgetting rewrites a stored view's text and keeps it within its bounds; a link the rewrite changed no longer opens,
// so it goes.
export const redactView = (view: ViewV1, redact: (value: string) => string): ViewV1 => {
  const out = mapViewText(view, (value, max, oneLine) => fitText(redact(value), max, oneLine));
  if (out.kind !== 'options' || view.kind !== 'options') return out;
  return { ...out, items: out.items.map(({ link, ...item }, index) => (link !== undefined && link === view.items[index]!.link ? { ...item, link } : item)) };
};

const cut = (value: string, max: number) => value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
const fitText: Rewrite = (value, max, oneLine) => cut(oneLine ? value.replace(/\s*[\n\r\u2028\u2029]+\s*/g, ' ') : value, max);

// The model's view fitted to the bounds, with how many entries did not fit. Nothing is refused for its size: the owner
// sees the first entries, and the count lets the reply say how many more there are.
export const fitView = (input: ViewInput): Readonly<{ view: ViewV1; left_out: number }> => {
  const B = VIEW_BOUNDS;
  const fitted = mapViewText(withOpenableLinks(input), fitText);
  const keep = <T>(items: readonly T[], max: number) => ({ kept: items.slice(0, max), dropped: Math.max(items.length - max, 0) });
  switch (fitted.kind) {
    case 'options': {
      const { kept, dropped } = keep(fitted.items, B.options);
      const items = kept.map(({ facts, ...item }) => ({ ...item, ...(facts?.length ? { facts: facts.slice(0, B.facts) } : {}) }));
      return { view: viewV1Schema.parse({ ...fitted, items }), left_out: dropped };
    }
    case 'table': {
      const columns = fitted.columns.slice(0, B.columns);
      const { kept, dropped } = keep(fitted.rows, B.rows);
      const rows = kept.map(row => columns.map((_, index) => row[index] ?? ''));
      return { view: viewV1Schema.parse({ ...fitted, columns, rows }), left_out: dropped };
    }
    case 'steps': {
      const { kept, dropped } = keep(fitted.items, B.steps);
      return { view: viewV1Schema.parse({ ...fitted, items: kept }), left_out: dropped };
    }
    case 'timeline': {
      const { kept, dropped } = keep(fitted.items, B.timeline);
      return { view: viewV1Schema.parse({ ...fitted, items: kept }), left_out: dropped };
    }
  }
};

const STEP_MARK = { done: '[x]', current: '[>]', todo: '[ ]' } as const;
// The view as plain text, for every surface that shows only text, and for any reader that cannot draw the part.
export const viewFallbackText = (view: ViewV1): string => {
  const lines: string[] = view.title ? [view.title] : [];
  switch (view.kind) {
    case 'options':
      view.items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.title}${item.pick ? ' (Waldo\'s pick)' : ''}${item.subtitle ? ` - ${item.subtitle}` : ''}`);
        if (item.facts?.length) lines.push(`   ${item.facts.map(fact => `${fact.label}: ${fact.value}`).join(' · ')}`);
        if (item.note) lines.push(`   ${item.note.replace(/\n+/g, ' ')}`);
        if (item.link) lines.push(`   ${item.link}`);
      });
      break;
    case 'table':
      lines.push(view.columns.join(' | '), ...view.rows.map(row => row.map(cell => cell || '-').join(' | ')));
      break;
    case 'steps':
      view.items.forEach(item => lines.push(`${item.state ? `${STEP_MARK[item.state]} ` : '- '}${item.title}${item.detail ? `: ${item.detail.replace(/\n+/g, ' ')}` : ''}`));
      break;
    case 'timeline':
      view.items.forEach(item => lines.push(`${item.when}  ${item.title}${item.detail ? `: ${item.detail.replace(/\n+/g, ' ')}` : ''}`));
      break;
  }
  const text = lines.join('\n');
  if (text.length <= REPLY_FALLBACK_MAX_CHARS) return text;
  // A whole line or nothing, so a cut never ends mid-word or mid-link.
  const end = text.lastIndexOf('\n', REPLY_FALLBACK_MAX_CHARS - 2);
  return `${text.slice(0, end > 0 ? end : REPLY_FALLBACK_MAX_CHARS - 2)}\n…`;
};

export const viewPart = (view: ViewV1): ReplyViewPartV1 => ({ type: 'view', view, fallback_text: viewFallbackText(view) });
