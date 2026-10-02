import {afterEach,describe,it,expect,vi} from 'vitest';
import {fetchMemoryControls,readMemoryControls} from './MemoryActions';
import {SignInRequired} from './model';
import {submitControl} from './controls-model';
const id='owner:claim:5';
const wire={version:1,view:'memory',state:'available',csrf:'c'.repeat(64),revision:'a'.repeat(64),data:{id,status:'active',review:{label:'Current saved preference',note:'Writer note'},actions:['spot.confirm','spot.dismiss','spot.forget']}};
afterEach(()=>vi.unstubAllGlobals());
describe('Memory action review and transport',()=>{
 it('requires a current review and exact target, never accepts another owner or a hidden pending body',()=>{
  expect(()=>readMemoryControls({...wire,data:{...wire.data,id:'other:claim:5'}},id)).toThrow();
  expect(()=>readMemoryControls({...wire,data:{...wire.data,review:undefined}},id)).toThrow();
  expect(()=>readMemoryControls({...wire,data:{...wire.data,actions:['approval.approve']}},id)).toThrow();
  const parsed=readMemoryControls({...wire,secret:'hidden',data:{...wire.data,source_ref:'private',review:{...wire.data.review,source_ref:'private'}}},id);
  expect(parsed.data.review).toEqual({label:'Current saved preference',note:'Writer note'});
  expect(JSON.stringify(parsed)).not.toContain('private');
  expect(readMemoryControls({...wire,data:{id,status:'purging',actions:['spot.forget']}},id).data.review).toBeUndefined();
 });
 it('uses the protected same-origin item read and separates sign-in from unavailable',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json(wire)).mockResolvedValueOnce(new Response(null,{status:401})).mockResolvedValueOnce(new Response(null,{status:503}));vi.stubGlobal('fetch',fetcher);
  expect(await fetchMemoryControls(id)).toEqual(readMemoryControls(wire,id));
  expect(fetcher.mock.calls[0][0]).toBe('/console/dashboard/api/v1/memory-controls?id=owner%3Aclaim%3A5');
  expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:'same-origin',cache:'no-store',redirect:'error'});
  await expect(fetchMemoryControls(id)).rejects.toBeInstanceOf(SignInRequired);await expect(fetchMemoryControls(id)).rejects.toThrow('could not load');
 });
 it('replays a lost Memory response with its original target, revision and request identity',async()=>{
  const fetcher=vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(Response.json({duplicate:true,receipt:{state:'recorded',message:'Confirmed'}}));vi.stubGlobal('fetch',fetcher);
  const reviewed=readMemoryControls(wire,id);
  await expect(submitControl(reviewed,'spot.confirm',{id:reviewed.data.id},'memory-request-001')).rejects.toMatchObject({uncertain:true});
  expect((await submitControl(reviewed,'spot.confirm',{id:reviewed.data.id},'memory-request-001')).duplicate).toBe(true);
  for(const call of fetcher.mock.calls){const body=call[1].body as FormData;expect(body.get('id')).toBe(id);expect(body.get('revision')).toBe(wire.revision);expect(body.get('request_id')).toBe('memory-request-001');}
 });
});
