import {describe,expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryList,MemoryDetailView,PatternExplorer} from './Memory';
import {readMemory,type MemoryPage,type MemoryDetail,type MemoryPattern} from './memory-model';
import {response} from './memory-test-fixtures';
describe('modern Memory presentation',()=>{
 it('renders returned Spots directly with honest origin and in-shell detail links',()=>{
  const html=renderToStaticMarkup(<MemoryList data={readMemory(response('view=claims&limit=25')) as MemoryPage} onNext={()=>{}} onRestart={()=>{}}/>);
  expect(html).toContain('&lt;script&gt;claim&lt;/script&gt;');expect(html).not.toContain('<script>');expect(html).toContain('Shared');expect(html).toContain('Waldo’s inference');expect(html).toContain('#/memory/spots?id=');expect(html).toContain('1 returned');expect(html).not.toContain('Open Spots');
 });
 it('keeps incomplete reads distinct from true empty and offers retry/restart',()=>{
  const data=readMemory(response('view=claims&limit=25')) as MemoryPage;
  const html=renderToStaticMarkup(<MemoryList data={{...data,complete:false,state:'partial',items:[],page:{limit:25,returned:0,total:0,next_cursor:null}}} onNext={()=>{}} onRestart={()=>{}}/>);
  expect(html).toContain('Incomplete');expect(html).not.toContain('No saved Spots');expect(html).toContain('Refresh list');
 });
 it('distinguishes an empty stale page from an empty entire list',()=>{
  const data=readMemory(response('view=claims&limit=25')) as MemoryPage;
  const html=renderToStaticMarkup(<MemoryList data={{...data,items:[],page:{limit:25,returned:0,total:2,next_cursor:null}}} onNext={()=>{}} onRestart={()=>{}}/>);
  expect(html).toContain('No records returned on this page');expect(html).not.toContain('complete available list');expect(html).toContain('First page');
 });
 it('labels writer evidence and source pointers and preserves supported mutation recovery',()=>{
  const html=renderToStaticMarkup(<MemoryDetailView data={readMemory(response('view=detail&id=synthetic-owner:claim:1')) as MemoryDetail}/>);
  expect(html).toContain('Writer note');expect(html).toContain('not proof');expect(html).toContain('Source pointer withheld');expect(html).toContain('Linked saved patterns');expect(html).not.toContain('hidden-message');expect(html).not.toContain('>Approve');
 });
 it('renders only saved pattern associations with keyboard/list fallback and capped-link honesty',()=>{
  const data=readMemory(response('view=pattern&id=synthetic-owner:node:1&max_nodes=12&max_links=20')) as MemoryPattern;
  const html=renderToStaticMarkup(<PatternExplorer data={{...data,expand:{...data.expand,links_capped:true,capped_links:1},omitted_links:1,truncated:true}} onNext={()=>{}} onRestart={()=>{}}/>);
  expect(html).toContain('<svg');expect(html).toContain('role="button"');expect(html).toContain('tabindex="0"');expect(html).toContain('Saved branches');expect(html).toContain('Unverified association');expect(html).toContain('cannot be recovered');expect(html).toContain('tentative');expect(html).not.toContain('Your days');
 });
});
