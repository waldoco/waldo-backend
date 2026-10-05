import { describe, expect, it } from 'vitest';
import { selectedForgetResult, selectedForgetTexts } from '../src/memory/selective-forget';

const topic = 'ZEBRA-COBALT';
const snap = (sources: { ref: string; text: string }[]) => ({ sources, incomplete: false, more: false }) as never;
const pick = (spans: unknown[], refs: string[]) => JSON.stringify({ complete: true, spans, reviewed_refs: refs });

describe('selectedForgetResult names why a selection was rejected (no content)', () => {
  const sources = [{ ref: 'loop:l1:title', text: 'follow up on the ZEBRA-COBALT quote' }, { ref: 'conversation:c1:model', text: 'my ZEBRA-COBALT contact is Priya' }];
  it('accepts a full selection and keeps selectedForgetTexts identical', () => {
    const raw = pick([{ ref: 'loop:l1:title', text: 'follow up on the ZEBRA-COBALT quote' }, { ref: 'conversation:c1:model', text: 'my ZEBRA-COBALT contact is Priya' }], sources.map(s => s.ref));
    expect(selectedForgetResult(topic, snap(sources), raw, snap(sources))).toHaveProperty('texts');
    expect(selectedForgetTexts(topic, snap(sources), raw, snap(sources))).toHaveLength(2);
  });
  it('names the row class that got no span', () => {
    const raw = pick([{ ref: 'loop:l1:title', text: 'follow up on the ZEBRA-COBALT quote' }], sources.map(s => s.ref));
    expect(selectedForgetResult(topic, snap(sources), raw, snap(sources))).toEqual({ reason: 'row_without_span:conversation' });
    expect(selectedForgetTexts(topic, snap(sources), raw, snap(sources))).toBeNull();
  });
  it('purges a reviewed chat line (episodes) that got no span as one whole line, and keeps other stores held', () => {
    const rows = [{ ref: 'episodes:12', text: 'Standup moved; also ZEBRA-COBALT is the new vendor code' }, { ref: 'loop:l1:title', text: 'follow up on the ZEBRA-COBALT quote' }];
    const refs = rows.map(r => r.ref);
    const loopSpan = { ref: 'loop:l1:title', text: 'follow up on the ZEBRA-COBALT quote' };
    expect(selectedForgetResult(topic, snap(rows), pick([loopSpan], refs), snap(rows))).toEqual({ texts: ['Standup moved; also ZEBRA-COBALT is the new vendor code', 'follow up on the ZEBRA-COBALT quote'].sort((a, b) => b.length - a.length), wholeRows: 1 });
    expect(selectedForgetResult(topic, snap(rows), pick([{ ref: 'episodes:12', text: 'also ZEBRA-COBALT is the new vendor code' }], refs), snap(rows))).toEqual({ reason: 'row_without_span:loop' });
    const long = [{ ref: 'episodes:13', text: `ZEBRA-COBALT ${'x'.repeat(4100)}` }];
    expect(selectedForgetResult(topic, snap(long), pick([], ['episodes:13']), snap(long))).toEqual({ reason: 'row_without_span:episodes' });
  });
  it('names a topic-only row (a span of just the topic can never be selected)', () => {
    const only = [{ ref: 'note:n1', text: 'ZEBRA-COBALT' }];
    const raw = pick([{ ref: 'note:n1', text: 'ZEBRA-COBALT' }], ['note:n1']);
    expect(selectedForgetResult(topic, snap(only), raw, snap(only))).toEqual({ reason: 'span_is_topic_only' });
  });
  it('names span, output and snapshot failures', () => {
    expect(selectedForgetResult(topic, snap(sources), 'nope', snap(sources))).toEqual({ reason: 'selector_output_not_json' });
    expect(selectedForgetResult(topic, snap(sources), pick([], []), snap(sources))).toEqual({ reason: 'reviewed_refs_mismatch' });
    expect(selectedForgetResult(topic, { sources, incomplete: true, more: false } as never, '{}', snap(sources))).toEqual({ reason: 'snapshot_incomplete_or_changed' });
    const bad = pick([{ ref: 'loop:l1:title', text: 'a clause without the marker in it' }, { ref: 'conversation:c1:model', text: 'my ZEBRA-COBALT contact is Priya' }], sources.map(s => s.ref));
    expect(selectedForgetResult(topic, snap(sources), bad, snap(sources))).toEqual({ reason: 'span_not_in_source_or_no_topic' });
  });
});
