import {expect,it,vi} from 'vitest';
import {driveRestClient} from '../src/connectors/drive-rest';
const id='document_123456';const at='2026-10-03T10:00:00Z';
const meta={id,name:'Plan',mimeType:'application/vnd.google-apps.document',modifiedTime:at,version:'17',capabilities:{canDownload:true}};
const fixture=(body='Actual plan text',overrides:Record<string,unknown>={},after:Record<string,unknown>={})=>{
 const urls:string[]=[];let count=0;
 const fetcher=vi.fn(async(raw:RequestInfo|URL)=>{const url=new URL(String(raw));urls.push(url.toString());if(url.searchParams.has('fields'))return Response.json({...meta,...overrides,...(++count===2?after:{})});return new Response(body,{headers:{'content-type':'text/plain; charset=utf-8'}});});
 return {client:driveRestClient(fetcher,async()=> 'fixture-token'),urls,fetcher};
};
const args={fileId:id,expectedModifiedTime:at};
it('exports actual Google Docs text and verifies identity/version around content',async()=>{const f=fixture();const r=await f.client.driveReadFileContent(args);expect(r).toMatchObject({file:{id,mimeType:meta.mimeType},text:'Actual plan text',contentMimeType:'text/plain',version:'17',truncated:false});expect(f.urls).toHaveLength(3);expect(new URL(f.urls[1]!).pathname).toBe(`/drive/v3/files/${id}/export`);expect(new URL(f.urls[1]!).searchParams.get('mimeType')).toBe('text/plain');});
it('native plain text uses media and never provider export links',async()=>{const f=fixture('Plain contents',{mimeType:'text/plain',exportLinks:{'text/plain':'https://evil.invalid'}});expect(await f.client.driveReadFileContent(args)).toMatchObject({text:'Plain contents'});expect(new URL(f.urls[1]!).searchParams.get('alt')).toBe('media');});
it.each(['application/pdf','application/vnd.google-apps.spreadsheet','application/vnd.google-apps.shortcut'])('unsupported %s never downloads',async mimeType=>{const f=fixture('secret',{mimeType});await expect(f.client.driveReadFileContent(args)).rejects.toMatchObject({code:'drive_content_unsupported'});expect(f.urls).toHaveLength(1);});
it('stale selected metadata refuses before downloading',async()=>{const f=fixture();await expect(f.client.driveReadFileContent({...args,expectedModifiedTime:'2025-01-01T00:00:00Z'})).rejects.toMatchObject({code:'drive_source_changed'});expect(f.urls).toHaveLength(1);});
it.each([{version:'18'},{modifiedTime:'2026-10-03T11:00:00Z'},{id:'foreign'},{mimeType:'text/plain'}])('changed source discards body (%j)',async after=>{const f=fixture('PRIVATE_CANARY',{},after);await expect(f.client.driveReadFileContent(args)).rejects.toMatchObject({code:'drive_source_changed'});});
it('wrong identity, missing version or download restriction fail closed',async()=>{for(const overrides of [{id:'foreign'},{version:undefined},{capabilities:{canDownload:false}}]){const f=fixture('secret',overrides);await expect(f.client.driveReadFileContent(args)).rejects.toBeInstanceOf(Error);expect(f.urls).toHaveLength(1);}});
it('bounded text is explicitly truncated without replacement Unicode',async()=>{const f=fixture('😀'.repeat(10000));const r=await f.client.driveReadFileContent(args);expect(r.truncated).toBe(true);expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(8192);expect(r.text).not.toContain('�');expect(JSON.stringify(r.text).length).toBeLessThanOrEqual(8192);});
it('content arguments reject before credentials or HTTP',async()=>{const f=fixture();for(const a of [{...args,fileId:'../escape'},{...args,url:'https://evil.invalid'},{fileId:id},{...args,maxBytes:999999}])await expect(f.client.driveReadFileContent(a as never)).rejects.toMatchObject({code:'drive_invalid_request'});expect(f.fetcher).not.toHaveBeenCalled();});
it('unexpected returned MIME is never mistaken for document contents',async()=>{let n=0;const f=vi.fn(async()=>++n===1?Response.json(meta):new Response('<html>Login</html>',{headers:{'content-type':'text/html'}}));await expect(driveRestClient(f,async()=> 'fixture').driveReadFileContent(args)).rejects.toMatchObject({code:'drive_invalid_response'});});
it('a stalled refresh times out with a safe code and no later provider call',async()=>{
 vi.useFakeTimers();const http=vi.fn();let release!:(value:string)=>void;const pending=new Promise<string>(resolve=>{release=resolve;});
 const result=driveRestClient(http,()=>pending).driveReadFileContent(args);const check=expect(result).rejects.toMatchObject({code:'drive_read_failed'});
 await vi.advanceTimersByTimeAsync(10_001);await check;release('fixture');await Promise.resolve();await Promise.resolve();expect(http).not.toHaveBeenCalled();vi.useRealTimers();
});
it('control-heavy content still stays within escaped inline budget',async()=>{const f=fixture('\u0001'.repeat(20000));const r=await f.client.driveReadFileContent(args);expect(r.truncated).toBe(true);expect(JSON.stringify(r.text).length).toBeLessThanOrEqual(8192);});
it('oversized streaming content is cancelled at the byte boundary',async()=>{
 let reads=0;let cancelled=false;const stream=new ReadableStream<Uint8Array>({pull(controller){reads++;controller.enqueue(new TextEncoder().encode('x'.repeat(65536)));},cancel(){cancelled=true;}});let n=0;
 const fetcher=vi.fn(async()=>++n===2?new Response(stream,{headers:{'content-type':'text/plain'}}):Response.json(meta));
 const result=await driveRestClient(fetcher,async()=> 'fixture').driveReadFileContent(args);expect(result.truncated).toBe(true);expect(result.returnedBytes).toBeLessThanOrEqual(8192);expect(cancelled).toBe(true);expect(reads).toBeLessThanOrEqual(2);
});
it.each([401,403,404,429,500])('content HTTP %i returns only a safe typed error',async status=>{
 let n=0;const fetcher=vi.fn(async()=>++n===1?Response.json(meta):new Response('PRIVATE_PROVIDER_ERROR_CANARY',{status,headers:{'content-type':'text/plain'}}));
 const result=driveRestClient(fetcher,async()=> 'fixture').driveReadFileContent(args);await expect(result).rejects.toMatchObject({status});try{await result;}catch(error){expect(String(error)).not.toContain('PRIVATE_PROVIDER_ERROR_CANARY');}
});
