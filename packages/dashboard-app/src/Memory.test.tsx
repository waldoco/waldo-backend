import {afterEach,describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryPanel,MemoryList,MemoryDetailView} from './Memory';
import {readMemory,type MemoryPage,type MemoryDetail} from './memory-model';
import {response} from './memory-test-fixtures';
afterEach(()=>vi.unstubAllGlobals());
describe('modern Memory presentation',()=>{
 it('keeps originating list context in list and detail links',()=>{
  const origin={view:'spots' as const,cursor:'saved-page'};
  const page=renderToStaticMarkup(<MemoryList initialView="list" data={readMemory(response('view=claims&limit=25')) as MemoryPage} returnTo={origin} onNext={()=>{}} onRestart={()=>{}}/>);
  expect(page).toContain('returnView=spots&amp;returnCursor=saved-page');
  const detail=renderToStaticMarkup(<MemoryDetailView data={readMemory(response('view=detail&id=synthetic-owner:claim:1')) as MemoryDetail} returnTo={origin}/>);
  expect(detail).toContain('#/memory/spots?cursor=saved-page');
  expect(detail).toContain('Back to Spots');
 });
 it('renders invalid Memory selectors as recovery without action controls or network requests',()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);vi.stubGlobal('window',{location:{hash:'#/memory/spots?id=1&owner=other'}});
  const html=renderToStaticMarkup(<MemoryPanel subview="spots"/>);
  expect(html).toContain('Memory link unavailable');expect(html).toContain('Return to Spots');expect(html).not.toContain('Loading');expect(html).not.toContain('Review actions');expect(fetch).not.toHaveBeenCalled();
 });
 it('renders returned Spots directly with honest origin and in-shell detail links',()=>{
  const html=renderToStaticMarkup(<MemoryList initialView="list" data={readMemory(response('view=claims&limit=25')) as MemoryPage} onNext={()=>{}} onRestart={()=>{}}/>);
  expect(html).toContain('&lt;script&gt;claim&lt;/script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('Shared');expect(html).toContain('Waldo’s inference');expect(html).toContain('#/memory/spots?id=');expect(html).toContain('Spots in this read');expect(html).not.toContain('Open Spots');
 });
 it('keeps incomplete reads distinct from true empty and offers retry/restart',()=>{
  const data=readMemory(response('view=claims&limit=25')) as MemoryPage;
  const html=renderToStaticMarkup(<MemoryList initialView="list" data={{...data,complete:false,state:'partial',items:[],page:{limit:25,returned:0,total:0,next_cursor:null}}} onNext={()=>{}} onRestart={()=>{}}/>);
  expect(html).toContain('Incomplete');expect(html).not.toContain('No saved Spots');expect(html).toContain('Refresh list');
 });
 it('distinguishes an empty stale page from an empty entire list',()=>{
  const data=readMemory(response('view=claims&limit=25')) as MemoryPage;
  const html=renderToStaticMarkup(<MemoryList initialView="list" data={{...data,items:[],page:{limit:25,returned:0,total:2,next_cursor:null}}} onNext={()=>{}} onRestart={()=>{}}/>);
  expect(html).toContain('Nothing on this page');expect(html).not.toContain('complete available list');expect(html).toContain('First page');
 });
 it('labels writer evidence and source pointers and preserves supported mutation recovery',()=>{
  const html=renderToStaticMarkup(<MemoryDetailView data={readMemory(response('view=detail&id=synthetic-owner:claim:1')) as MemoryDetail}/>);
  expect(html).toContain('Writer’s note');expect(html).toContain('not proof');expect(html).toContain('Source pointer withheld');expect(html).not.toContain('hidden-message');expect(html).not.toContain('>Approve');
 });
});
it('puts evidence before collapsed technical metadata without implying a source link',()=>{
 const html=renderToStaticMarkup(<MemoryDetailView data={readMemory(response('view=detail&id=synthetic-owner:claim:1')) as MemoryDetail}/>);
 expect(html.indexOf('A writer note')).toBeLessThan(html.indexOf('Technical details'));
 expect(html).toContain('<details');expect(html).toContain('not an original-message link');expect(html).toContain('Writer seen count');
});
it('never labels an untrusted-origin Spot as Shared on cards or detail',()=>{
 const page=readMemory(response('view=claims&limit=25')) as MemoryPage;
 const cards=renderToStaticMarkup(<MemoryList initialView="list" data={{...page,items:page.items.map(item=>({...item,origin:'untrusted'}))}} onNext={()=>{}} onRestart={()=>{}}/>);
 const detail=readMemory(response('view=detail&id=synthetic-owner:claim:1')) as MemoryDetail;
 if(detail.kind!=='claim')throw new Error('Expected claim fixture');
 const html=renderToStaticMarkup(<MemoryDetailView data={{...detail,item:{...detail.item,origin:'untrusted'}}}/>);
 for(const result of [cards,html]){expect(result).toContain('Untrusted origin');expect(result).not.toContain('Shared');}
});
