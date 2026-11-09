import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { workspaceStore, type WorkspaceState } from '@waldo/workspace';
import { workspaceToolHandlers } from '../src/tools/live/workspace';
const id = (n: number) => `abcdefab-cdef-4abc-8abc-${n.toString(16).padStart(12,'0')}`;
const setup = async (origin: string | null = 'https://waldo.example') => {
 let state: WorkspaceState = {binding:null,files:[],bodies:[],operations:[]}; let n=10; const objects = new Map<string,Uint8Array>();
 const store = await workspaceStore({binding:{ownerId:id(1),environment:'test',namespace:'ns',doName:'owner',doId:'do',stateVersion:1,mappingVersion:1},admit:async()=>({status:'ok'}),metadata:{transaction(f){const s=structuredClone(state);const r=f(s);state=s;return r;}},bodies:{put:async(b,v)=>{objects.set(b.blob_id,v)},get:async b=>objects.get(b.blob_id)??null,remove:async b=>{objects.delete(b.blob_id)}},now:()=>0,newId:()=>id(n++)});
 const handlers = workspaceToolHandlers(async()=>store,{origin:async()=>origin,durable:true});
 const render=handlers.find(h=>h.name==='workspace_render');
 const source=async(text:string,mime='text/markdown')=>store.write({path:'source.md',bytes:new TextEncoder().encode(text),mime,expected_revision:0,provenance:'agent_generated',operation_id:id(2)});
 const call=async(args:unknown,call='render-1')=>render!.handle(args as never,{authenticatedUserId:'owner',turnId:'turn',toolCallId:call} as never);
 return {store,source,call,handlers,state:()=>state};
};
const args=(file_id:string,format='pdf',path=`out.${format}`)=>({source_file_id:file_id,source_revision:1,path,expected_revision:0,format});
describe('workspace_render',()=>{
 it('is installed alongside all existing workspace tools',async()=>{expect((await setup()).handlers.map(h=>h.name)).toContain('workspace_render')});
 it.each(['pdf','docx'])('stores a real %s document and delivers an owner-only immutable link',async format=>{
  const w=await setup(),s=await w.source('# Title\n- One\nBody'); const r:any=await w.call(args(s.file_id,format));expect(r.ok).toBe(true);expect(r.data.delivery).toEqual({status:'owner_link',url:`https://waldo.example/console/workspace/file?id=${r.data.file_id}&revision=1`,audience:'owner_authenticated'});
  const out=await w.store.export(r.data.file_id,1);expect(out.meta.sha256).toBe(r.data.sha256);expect(out.bytes.length).toBe(r.data.byte_size);
  if(format==='pdf')expect(new TextDecoder().decode(out.bytes.slice(0,5))).toBe('%PDF-');else expect(await (await JSZip.loadAsync(out.bytes)).file('word/document.xml')!.async('string')).toContain('Title');
  expect(await w.call(args(s.file_id,format))).toEqual(r);expect(w.state().files).toHaveLength(2);expect(w.state().bodies).toHaveLength(2);expect((await w.call(args(s.file_id,format),'render-2')).ok).toBe(false);
 });
 it('preserves DOCX Unicode and refuses unsupported PDF text without a write',async()=>{const w=await setup(),s=await w.source('नमस्ते 😀 café');const r:any=await w.call(args(s.file_id,'docx'));const out=await w.store.export(r.data.file_id,1);expect(await(await JSZip.loadAsync(out.bytes)).file('word/document.xml')!.async('string')).toContain('नमस्ते 😀 café');expect(await w.call(args(s.file_id,'pdf'),'other')).toMatchObject({ok:false,error:expect.stringContaining('unsupported_text')});expect(w.state().files).toHaveLength(2)});
 it('missing origin never invents a URL',async()=>{const w=await setup(null),s=await w.source('Hello');expect(await w.call(args(s.file_id))).toMatchObject({ok:true,data:{delivery:{status:'saved_internal',url:null,audience:'unverified'}}})});
 it('wrong source revision and foreign id write nothing',async()=>{const w=await setup(),s=await w.source('Hello');expect((await w.call({...args(s.file_id),source_revision:2})).ok).toBe(false);expect((await w.call(args(id(999)))).ok).toBe(false);expect(w.state().files).toHaveLength(1)});
 it('refuses oversized source and binary source',async()=>{const w=await setup(),s=await w.source('é'.repeat(16001));expect(await w.call(args(s.file_id))).toMatchObject({ok:false});expect(w.state().files).toHaveLength(1);const b=await setup(),bs=await b.source('hi','application/pdf');expect((await b.call(args(bs.file_id))).ok).toBe(false)});
 it('MD/TXT write receipts use the same delivery helper',async()=>{const w=await setup();const h=w.handlers.find(h=>h.name==='workspace_write')!;const r:any=await h.handle({path:'plain.txt',text:'Hi',mime:'text/plain',expected_revision:0} as never,{authenticatedUserId:'owner',turnId:'t',toolCallId:'w'} as never);expect(r.data.delivery.status).toBe('owner_link')});
});

it('renderer ignores hostile HTML/images as text without network I/O',async()=>{
 const {renderWorkspaceDocument}=await import('../src/channels/document-render');
 const {vi}=await import('vitest'); const fetcher=vi.spyOn(globalThis,'fetch');
 try { for(const format of ['pdf','docx'] as const)expect((await renderWorkspaceDocument('<script>alert(1)</script>\n![x](https://hostile.invalid/a)',format)).status).toBe('exported');expect(fetcher).not.toHaveBeenCalled(); }
 finally {fetcher.mockRestore()}
});
it('maximum 32,000 byte source renders in workerd and unsupported format/extra fields are rejected',async()=>{
 const {workspaceRenderArgsSchema,TOOL_PERMISSIONS}=await import('@waldo/contracts');
 expect(Object.entries(TOOL_PERMISSIONS).filter(([,tools])=>tools.includes('workspace_render')).map(([key])=>key)).toEqual(['user_message']);
 expect(workspaceRenderArgsSchema.safeParse({...args(id(1)),format:'pptx'}).success).toBe(false);
 expect(workspaceRenderArgsSchema.safeParse({...args(id(1)),operation_id:id(7)}).success).toBe(false);
 const w=await setup(),s=await w.source('A paragraph of text.\n'.repeat(1600).slice(0,32000));
 for(const format of ['pdf','docx'])expect(await w.call(args(s.file_id,format),format)).toMatchObject({ok:true});
});
it('invalid origin, blank source, bad suffix and closed render runs give no false success',async()=>{
 const w=await setup('http://waldo.example'),s=await w.source('Hello');expect(await w.call(args(s.file_id))).toMatchObject({ok:true,data:{delivery:{status:'saved_internal',url:null}}});
 expect(await w.call(args(s.file_id,'pdf','out.docx'),'suffix')).toMatchObject({ok:false,code:'invalid_args'});
 const blank=await setup(),bs=await blank.source('  ');expect(await blank.call(args(bs.file_id))).toMatchObject({ok:false});
 const closed=await setup(),cs=await closed.source('Hello');const h=closed.handlers.find(h=>h.name==='workspace_render')!;
 expect(await h.handle(args(cs.file_id) as never,{authenticatedUserId:'owner',turnId:'t',toolCallId:'c',runScope:{admit(){throw Error('closed')}}} as never)).toMatchObject({ok:false});expect(closed.state().files).toHaveLength(1);
});

it('a maximum-size unbroken token is safely renderable in workerd',async()=>{
 const {renderWorkspaceDocument}=await import('../src/channels/document-render');
 expect((await renderWorkspaceDocument('W'.repeat(32000),'pdf')).status).toBe('exported');
});
it('invalid UTF8 text source is rejected without an output write',async()=>{
 const w=await setup();const s=await w.store.write({path:'invalid.txt',bytes:new Uint8Array([255]),mime:'text/plain',expected_revision:0,operation_id:id(3),provenance:'owner_upload'});
 expect(await w.call(args(s.file_id))).toMatchObject({ok:false,code:'invalid_args'});expect(w.state().files).toHaveLength(1);
});
it('DOCX rejects XML-forbidden text instead of saving a corrupt Word file',async()=>{
 const {renderWorkspaceDocument}=await import('../src/channels/document-render');
 for(const text of ['bad\u0000text','bad\u000btext','bad\ufffetext'])expect(await renderWorkspaceDocument(text,'docx')).toEqual({status:'unsupported_text'});
});
