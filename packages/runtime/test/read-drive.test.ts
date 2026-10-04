import { describe, expect, it, vi } from 'vitest';
import {buildSessionState} from '@waldo/contracts';
import {dispatchTool} from '../src/tools/dispatcher';
import {sanitise} from '../src/scribe/sanitiser';
import {inMemoryToolOutputStore} from '../src/conversation/tool-output-store';
import { readDriveArgsSchema } from '@waldo/contracts';
import { readDriveHandler } from '../src/tools/live/drive';
import { GoogleError, GOOGLE_METHODS, type GoogleClient } from '../src/connectors/google';

const file = { id: 'f'.repeat(12), name: 'Plan', mimeType: 'application/pdf', modifiedTime: '2026-10-01T00:00:00Z', webViewLink: 'https://drive.google.com/x', size: '1024' };
const make = (client: Partial<GoogleClient> | null, enabled = true) => readDriveHandler({ client: async () => client as GoogleClient | null }, enabled);
const call = (h: ReturnType<typeof make>, a: Record<string, unknown>) => h.handle(readDriveArgsSchema.parse(a), {sanitise,session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:1})} as never);

describe('read_drive (Drive v3 metadata over the proxy client)', () => {
  it('is off unless enabled', async () => {
    expect(await call(make({}, false), { action: 'recent' })).toMatchObject({ ok: false, code: 'forbidden' });
  });
  it('lists, searches by name and gets one file, passing typed inputs only', async () => {
    const seen: unknown[] = [];
    const h = make({
      driveListFiles: async (i) => { seen.push(['recent', i]); return { files: [file], nextPageToken: 'n1', incompleteSearch: false }; },
      driveSearchFiles: async (i) => { seen.push(['search', i]); return { files: [file], nextPageToken: null, incompleteSearch: true }; },
      driveGetFileMetadata: async (i) => { seen.push(['get', i]); return file; },
    });
    expect(await call(h, { action: 'recent' })).toMatchObject({ ok: true, data: { files: [file], nextPageToken: 'n1', incompleteSearch: false } });
    expect(await call(h, { action: 'search', name_contains: "o'brien", page_size: 5 })).toMatchObject({ ok: true });
    expect(await call(h, { action: 'get', file_id: file.id })).toMatchObject({ ok: true, data: { file } });
    expect(seen).toEqual([['recent', { pageSize: 10 }], ['search', { nameContains: "o'brien", pageSize: 5 }], ['get', { fileId: file.id }]]);
  });
  it('drops every field except the six, even if the client returns more', async () => {
    const leaky = { ...file, contentSnippet: 'secret body', description: 'd', owners: [{ emailAddress: 'a@b.c' }], permissions: [] };
    const r = await call(make({ driveListFiles: async () => ({ files: [leaky], nextPageToken: null, incompleteSearch: true }) }), { action: 'recent' });
    expect(JSON.stringify(r)).not.toMatch(/secret body|owners|permissions|description/);
  });
  it('maps 401 to the reconnect path, 403 to a plain refusal with Google status, not a consent prompt', async () => {
    const r401 = await call(make({ driveListFiles: async () => { throw new GoogleError(401, 'expired'); } }), { action: 'recent' });
    expect(r401).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'reauth_needed', feature: 'drive' } });
    const r403 = await call(make({ driveListFiles: async () => { throw new GoogleError(403, 'accessNotConfigured'); } }), { action: 'recent' });
    expect(r403).toMatchObject({ ok: false, code: 'rejected' });
    expect((r403 as { connect?: unknown }).connect).toBeUndefined();
    expect((r403 as { error: string }).error).toContain('accessNotConfigured');
  });
  it('not connected is the typed connect intent; a client without the method is refused, never routed to MCP', async () => {
    expect(await call(make(null), { action: 'recent' })).toMatchObject({ ok: false, code: 'auth_failed', connect: { reason: 'not_connected' } });
    expect(await call(make({}), { action: 'recent' })).toMatchObject({ ok: false, code: 'rejected' });
  });
  it('schema: search needs name_contains, get needs a closed id, size capped at 50', () => {
    expect(readDriveArgsSchema.safeParse({ action: 'search' }).success).toBe(false);
    expect(readDriveArgsSchema.safeParse({ action: 'get', file_id: 'a b' }).success).toBe(false);
    expect(readDriveArgsSchema.safeParse({ action: 'recent', page_size: 51 }).success).toBe(false);
  });
  it('the three Drive methods are in the shared proxy method list', () => {
    expect(GOOGLE_METHODS).toEqual(expect.arrayContaining(['driveListFiles', 'driveSearchFiles', 'driveGetFileMetadata']));
  });
});

it('content reads actual text only for the selected account with external provenance',async()=>{
 const account={connection_id:'selected-connection',email:null};
 const content={file:{...file,mimeType:'text/plain'},text:'Actual document body',version:'17',contentMimeType:'text/plain' as const,truncated:false,returnedBytes:20,observedAt:'2026-10-03T10:00:00Z'};
 const h=readDriveHandler({client:async()=>({account,driveReadFileContent:async()=>content}) as unknown as GoogleClient},true,true);
 const args={action:'content',file_id:file.id,connection_id:account.connection_id,expected_modified_time:file.modifiedTime};
 expect(await call(h,args)).toMatchObject({ok:true,source_taint:'external',data:{...content,account}});
 expect(await call(h,{...args,connection_id:'foreign-account'})).toMatchObject({ok:false,code:'rejected'});
});
it('content is off unless its complete read boundary is explicitly enabled',async()=>{
 const h=readDriveHandler({client:async()=>({}) as GoogleClient},true);
 expect(await h.handle(readDriveArgsSchema.parse({action:'content',file_id:file.id,connection_id:'selected',expected_modified_time:file.modifiedTime}),undefined as never)).toMatchObject({ok:false,code:'forbidden'});
});
it('total escaped inline budget includes large metadata and marks extra cuts truthfully',async()=>{
 const account={connection_id:'selected',email:null};
 const large={file:{...file,name:'\u0001'.repeat(1024),mimeType:'text/plain',webViewLink:'https://drive.google.com/'+ 'x'.repeat(4000)},text:'"😀'.repeat(1300),version:'17',contentMimeType:'text/plain' as const,truncated:false,returnedBytes:6500,observedAt:'2026-10-03T10:00:00Z'};
 const h=readDriveHandler({client:async()=>({account,driveReadFileContent:async()=>large}) as unknown as GoogleClient},true,true);
 const result=await call(h,{action:'content',file_id:file.id,connection_id:'selected',expected_modified_time:file.modifiedTime});
 expect(result).toMatchObject({ok:true,source_taint:'external',data:{truncated:true}});expect(JSON.stringify(result).length).toBeLessThan(15_000);
 if(result.ok){const data=result.data as {text:string;returnedBytes:number};expect(data.returnedBytes).toBe(new TextEncoder().encode(data.text).byteLength);expect(data.text).not.toMatch(/[\uD800-\uDBFF]$/);}
});

it('dense email text stays inline, readable, and reports visible byte count',async()=>{
 const text='a@b.co '.repeat(1100);const account={connection_id:'selected',email:null};
 const content={file:{...file,mimeType:'text/plain'},text,version:'17',contentMimeType:'text/plain' as const,truncated:false,returnedBytes:new TextEncoder().encode(text).byteLength,observedAt:'2026-10-03T10:00:00Z'};
 const h=readDriveHandler({client:async()=>({account,driveReadFileContent:async()=>content}) as unknown as GoogleClient},true,true);
 const offload=inMemoryToolOutputStore();const put=vi.spyOn(offload,'put');
 const result=await dispatchTool({id:'dense-email',name:'read_drive',args:{action:'content',file_id:file.id,connection_id:'selected',expected_modified_time:file.modifiedTime}},{authenticatedUserId:'owner',trigger:'user_message',session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:1}),hasApproval:()=>false,sourceTaint:null,toolArgSourceTaint:null,sanitise},{handlers:[h],offload});
 expect(result.ok).toBe(true);expect(put).not.toHaveBeenCalled();expect(JSON.stringify(result).length).toBeLessThan(15_000);
 if(result.ok){const data=result.data as {text:string;returnedBytes:number;truncated:boolean};expect(data.text).toContain('a@b.co');expect(data.returnedBytes).toBe(new TextEncoder().encode(data.text).byteLength);expect(data.truncated).toBe(false);}
});
