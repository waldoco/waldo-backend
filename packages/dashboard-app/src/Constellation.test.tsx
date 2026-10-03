import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { branchLabel, branchPath, constellationScene, loadSavedSupport, PatternExplorer, springStep } from './Constellation';
import { readMemory, type Claim, type MemoryDetail, type MemoryPattern } from './memory-model';
import { response } from './memory-test-fixtures';

const pattern = () => readMemory(response('view=pattern')) as MemoryPattern;
const claim = () => (readMemory(response('view=detail&id=synthetic-owner:claim:1')) as MemoryDetail & { kind: 'claim' }).item;
const detailResponse = (id: string) => {
  const data = response('view=detail&id=synthetic-owner:claim:1');
  return { ...data, item: { ...('item' in data ? data.item : {}), id } };
};
afterEach(() => vi.unstubAllGlobals());

describe('saved Constellation branches', () => {
  it('wraps branch typography without changing the full accessible value', () => {
    expect(branchLabel('Keep mornings gentle')).toEqual(['Keep mornings', 'gentle']);
    expect(branchLabel('Gentler mornings')).toEqual(['Gentler mornings']);
    expect(branchLabel('A very long stored interpretation label with more words').every(line => line.length <= 18)).toBe(true);
    expect(branchPath({x:100,y:200},{x:300,y:400})).toBe('M 100 200 L 186 200 L 217.92000000000002 400 L 300 400');
  });

  it('draws only returned associations and exact selected-pattern support IDs', () => {
    const data = pattern();
    data.associations.push({ ...data.associations[0]!, to: 'foreign-pattern' }, { ...data.associations[0]!, to: data.center.id });
    const saved = claim();
    const foreign = { ...saved, id: 'foreign-claim' } as Claim;
    const scene = constellationScene(data, data.center.id, [saved, foreign, saved]);
    expect(scene.links).toEqual([
      { from: data.center.id, to: data.nodes[0]!.id, relation: 'possible support', kind: 'association' },
      { from: data.center.id, to: saved.id, relation: 'Stored supporting Spot', kind: 'support' },
    ]);
    expect(scene.claims).toEqual([saved]);
    expect(scene.nodes.map(node => node.id)).not.toContain(foreign.id);
    expect(scene.nodes.map(node => node.label)).not.toContain('Your days');
  });

  it('does not infer links from branch positions or another pattern’s support', () => {
    const data = pattern();
    data.nodes[0]! = { ...data.nodes[0]!, support: { ...data.nodes[0]!.support, claim_ids: ['other-spot'] } };
    const scene = constellationScene(data, data.nodes[0]!.id, [claim()]);
    expect(scene.focus.id).toBe(data.nodes[0]!.id);
    expect(scene.claims).toEqual([]);
    expect(scene.links.filter(link => link.kind === 'support')).toEqual([]);
    expect(scene.links).toHaveLength(1);
  });

  it('lays twelve neighboring patterns and a six-Spot preview inside the canvas', () => {
    const data = pattern();
    data.nodes = Array.from({ length: 12 }, (_, i) => ({ ...data.nodes[0]!, id: `pattern:${i}` }));
    const claims = Array.from({ length: 8 }, (_, i) => ({ ...claim(), id: `claim:${i}` }));
    data.center.support.claim_ids = claims.map(item => item.id);
    const scene = constellationScene(data, data.center.id, claims);
    expect(scene.claims).toHaveLength(6);
    expect(scene.nodes).toHaveLength(19);
    for (const node of scene.nodes) {
      expect(node.point.x).toBeGreaterThanOrEqual(38);
      expect(node.point.x).toBeLessThanOrEqual(722);
      expect(node.point.y).toBeGreaterThanOrEqual(35);
      expect(node.point.y).toBeLessThanOrEqual(465);
    }
    expect(new Set(scene.nodes.filter(node => node.kind === 'pattern').map(node => node.point.x)).size).toBeGreaterThan(3);
  });

  it('keeps a thirteenth and later peer inside the label-safe canvas', () => {
    const data = pattern();
    for (const count of [13, 18, 25]) {
      data.nodes = Array.from({ length: count }, (_, i) => ({ ...data.nodes[0]!, id: `pattern:${i}` }));
      const nodes = constellationScene(data, data.center.id, []).nodes;
      expect(nodes).toHaveLength(count + 1);
      for (const node of nodes) { expect(node.point.x).toBeLessThanOrEqual(695); expect(node.point.y).toBeLessThanOrEqual(405); }
      expect(new Set(nodes.map(node => `${node.point.x}:${node.point.y}`)).size).toBe(count + 1);
    }
  });

  it('escapes saved content and provides explicit counts, glyphs and a keyboard/list fallback', () => {
    const data = pattern();
    data.center = { ...data.center, label: '<script>pattern</script>', summary: '<img src=x onerror=evil()>', estimate: null };
    data.associations[0]!.relation = '<script>relation</script>';
    data.omitted_links = 2;
    data.expand = { ...data.expand, links_capped: true, capped_links: 2 };
    const html = renderToStaticMarkup(<PatternExplorer data={data} onNext={() => {}} onRestart={() => {}} />);
    expect(html).toContain('&lt;script&gt;pattern&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=evil()&gt;');
    expect(html).toContain('&lt;script&gt;relation&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('viewBox="0 0 760 500"');
    expect(html).toContain('<polygon');
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('list fallback');
    expect(html).toContain('1 of 1 returned neighboring patterns');
    expect(html).toContain('0 returned of 1 declared saved support IDs');
    expect(html).toContain('Uncalibrated model estimate: unavailable');
    expect(html).toContain('Independent observations remain unverified');
    expect(html).toContain('2 capped associations cannot be recovered');
    expect(html).toContain('#/memory/constellation?id=synthetic-owner%3Anode%3A1&amp;explore=1');
    expect(html).toContain('data-reduced-motion="true"');
    expect(html).not.toContain('source_refs');
    expect(html).not.toContain('original-message link');
    expect(html).not.toContain('Your days');
  });

  it('keeps incomplete and withheld records visible rather than claiming an empty graph', () => {
    const data = { ...pattern(), state: 'partial' as const, complete: false, unavailable_claim_count: 3 };
    const html = renderToStaticMarkup(<PatternExplorer data={data} onNext={() => {}} onRestart={() => {}} />);
    expect(html).toContain('This Memory read is partial');
    expect(html).toContain('3 claims withheld during removal');
    expect(html).toContain('Missing or withheld records are not an empty Memory or completed removal');
  });

  it('uses a bounded damped spring that converges and clamps positions', () => {
    let point = { x: 310, y: 250, vx: 0, vy: 0 };
    for (let frame = 0; frame < 46; frame++) point = springStep(point, { x: 75, y: 65 });
    expect(Math.abs(point.x - 75)).toBeLessThan(.1);
    expect(Math.abs(point.y - 65)).toBeLessThan(.1);
    expect(springStep({ x: -1000, y: 1000, vx: 0, vy: 0 }, { x: 310, y: 250 })).toMatchObject({ x: 38, y: 465 });
  });
});

describe('authoritative supporting Spot reads', () => {
  it('fetches at most six unique saved IDs with the same abort signal and reports omitted IDs', async () => {
    const data = pattern().center;
    const ids = Array.from({ length: 8 }, (_, i) => `saved:claim:${i}`);
    data.support.claim_ids = [...ids, ids[0]!];
    const fetch = vi.fn(async (url: string) => Response.json(detailResponse(new URL(url, 'https://waldo.example').searchParams.get('id')!)));
    vi.stubGlobal('fetch', fetch);
    const abort = new AbortController();
    const result = await loadSavedSupport(data, abort.signal);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(result.claims.map(item => item.id)).toEqual(ids.slice(0, 6));
    expect(result).toMatchObject({ requested: 6, omitted: 2, failed: 0, partial: false });
    for (const [url, options] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(new URL(url, 'https://waldo.example').pathname).toBe('/console/dashboard/api/v1/memory');
      expect(options).toMatchObject({ credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
    }
  });

  it('rejects foreign detail IDs and failures while retaining correctly matched partial support', async () => {
    const data = pattern().center;
    data.support.claim_ids = ['saved:claim:1', 'saved:claim:2', 'saved:claim:3', 'saved:claim:4'];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const id = new URL(url, 'https://waldo.example').searchParams.get('id')!;
      if (id.endsWith(':1')) return Response.json(detailResponse('foreign:claim:1'));
      if (id.endsWith(':2')) return new Response('private server failure', { status: 503 });
      if (id.endsWith(':3')) return Response.json({ ...detailResponse(id), state: 'partial', complete: false });
      return Response.json({ ...detailResponse(id), state: 'unavailable', complete: false });
    }));
    const result = await loadSavedSupport(data, new AbortController().signal);
    expect(result.claims.map(item => item.id)).toEqual(['saved:claim:3']);
    expect(result).toMatchObject({ failed: 3, partial: true, requested: 4 });
    expect(JSON.stringify(result)).not.toContain('private server failure');
  });

  it('reports sign-in expiry and abandons aborted selection reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    const abort = new AbortController();
    expect(await loadSavedSupport(pattern().center, abort.signal)).toMatchObject({ signedOut: true, failed: 1, claims: [] });
    abort.abort();
    await expect(loadSavedSupport(pattern().center, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
