import {afterEach,describe,expect,it,vi} from 'vitest';
import {fetchMemory,memoryItemLink,readMemory} from './memory-model';
import {SignInRequired} from './model';
import {response} from './memory-test-fixtures';
afterEach(()=>vi.unstubAllGlobals());
describe('owner Memory read client',()=>{
 it('reads the actual server list/detail/pattern shape, drops unrelated fields and withholds source pointers',()=>{
  const list=readMemory({...response('view=claims&limit=25'),secret:'never retain'});
  expect(list.view).toBe('claims');expect(list).not.toHaveProperty('secret');
  if(list.view==='claims') {expect(list.items[0]).not.toHaveProperty('source_ref');expect(list.items[0]).toMatchObject({origin:'shared',source_reference:{link:null,state:'unverified'}});}
  expect(readMemory(response('view=detail&id=synthetic-owner:claim:1')).view).toBe('detail');
  expect(readMemory(response('view=pattern&id=synthetic-owner:node:1&max_nodes=12&max_links=20')).view).toBe('pattern');
 });
 it('fails closed on mutation grants, unsupported evidence and dangling graph edges',()=>{
  expect(()=>readMemory({...response('view=claims&limit=25'),actions:['claim.confirm']})).toThrow();
  const pattern=response('view=pattern&id=synthetic-owner:node:1&max_nodes=12&max_links=20');
  expect(()=>readMemory({...pattern,associations:[{from:'foreign',to:'synthetic-owner:node:1',relation:'fake',state:'unverified_association',estimate:.3}]})).toThrow();
 });
 it('preserves partial suppression and never treats it as a complete empty list',()=>{
  const page=readMemory({...response('view=claims&limit=25'),complete:false,state:'partial',items:[],page:{limit:25,returned:0,total:0,next_cursor:null}});
  expect(page.complete).toBe(false);expect(page.state).toBe('partial');
 });
 it('uses protected same-origin no-store GETs and exposes signed-out/cursor recovery',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(response('view=claims&limit=25'))));vi.stubGlobal('fetch',fetch);
  await fetchMemory(new URLSearchParams('view=claims&limit=25'));
  expect(fetch).toHaveBeenCalledWith('/console/dashboard/api/v1/memory?view=claims&limit=25',expect.objectContaining({credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}}));
  fetch.mockResolvedValueOnce(new Response('',{status:401}));await expect(fetchMemory(new URLSearchParams())).rejects.toBeInstanceOf(SignInRequired);
  fetch.mockResolvedValueOnce(new Response('{"error":"memory_unavailable"}',{status:503}));await expect(fetchMemory(new URLSearchParams())).rejects.toMatchObject({code:'memory_unavailable'});
  expect(fetch.mock.calls.every((call)=>!call[1]?.method||call[1].method==='GET')).toBe(true);
  fetch.mockResolvedValueOnce(new Response('{"error":"cursor_invalid"}',{status:400}));await expect(fetchMemory(new URLSearchParams())).rejects.toMatchObject({code:'cursor_invalid'});
 });
 it('encodes opaque scoped item references in deep links',()=>expect(memoryItemLink('spots','scope:claim:1&extra=1')).toBe('#/memory/spots?id=scope%3Aclaim%3A1%26extra%3D1'));
});
