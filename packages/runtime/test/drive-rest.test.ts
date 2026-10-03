import {expect,it,vi} from 'vitest';
import {driveRestClient} from '../src/connectors/drive-rest';
it('recent metadata uses one fixed GET, bounded page and strips content',async()=>{
 const f=vi.fn(async()=>Response.json({files:[{id:'f1',name:'Report',mimeType:'application/pdf',modifiedTime:'2026-10-02T00:00:00Z',webViewLink:'https://drive.google.com/file/d/f1/view',size:'42',description:'PRIVATE',contentSnippet:'PRIVATE',owners:[]}],nextPageToken:'next',incompleteSearch:true}));
 expect(await driveRestClient(f,async()=> 'fixture-bearer').driveListFiles({})).toEqual({files:[{id:'f1',name:'Report',mimeType:'application/pdf',modifiedTime:'2026-10-02T00:00:00Z',webViewLink:'https://drive.google.com/file/d/f1/view',size:'42'}],nextPageToken:'next',incompleteSearch:true});
 expect(f).toHaveBeenCalledTimes(1);const [raw,init]=f.mock.calls[0] as unknown as [string,RequestInit];const u=new URL(raw);
 expect(u.origin+u.pathname).toBe('https://www.googleapis.com/drive/v3/files');expect(u.searchParams.get('q')).toBe('trashed = false');expect(u.searchParams.get('pageSize')).toBe('10');expect(u.searchParams.get('orderBy')).toBe('recency desc');expect(u.searchParams.get('fields')).toBe('nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,webViewLink,size)');expect(init).toMatchObject({method:'GET',redirect:'error',headers:{authorization:'Bearer fixture-bearer'}});
});
it('search escapes literal name and uses explicit single-page parameters',async()=>{
 const f=vi.fn(async()=>Response.json({files:[]}));await driveRestClient(f,async()=> 'fixture').driveSearchFiles({nameContains:"O'Reilly",pageSize:50,pageToken:'opaque'});
 const u=new URL((f.mock.calls[0] as unknown as [string])[0]);expect(u.searchParams.get('q')).toBe("trashed = false and name contains 'O\\'Reilly'");expect(u.searchParams.get('pageToken')).toBe('opaque');expect(u.searchParams.get('corpora')).toBe('user');expect(u.searchParams.get('spaces')).toBe('drive');
});
it('get fixes fields and rejects content flags and injected paths',async()=>{
 const f=vi.fn(async()=>Response.json({id:'f_1',name:'R',mimeType:'text/plain',description:'PRIVATE'}));const c=driveRestClient(f,async()=> 'fixture');expect(await c.driveGetFileMetadata({fileId:'f_1'})).toEqual({id:'f_1',name:'R',mimeType:'text/plain',modifiedTime:null,webViewLink:null,size:null});
 expect(new URL((f.mock.calls[0] as unknown as [string])[0]).searchParams.get('fields')).toBe('id,name,mimeType,modifiedTime,webViewLink,size');
 for(const a of [{fileId:'../x'},{fileId:'f',alt:'media'},{fileId:'f',fields:'*'}])await expect(c.driveGetFileMetadata(a)).rejects.toMatchObject({status:400,code:'drive_invalid_request'});expect(f).toHaveBeenCalledTimes(1);
});
it('invalid arguments reject before credentials and HTTP',async()=>{
 const f=vi.fn();const b=vi.fn();const c=driveRestClient(f,b);
 for(const a of [{pageSize:0},{pageSize:51},{pageSize:1.5},{pageToken:'x'.repeat(2049)},{fields:'*'},null])await expect(c.driveListFiles(a as never)).rejects.toMatchObject({status:400,code:'drive_invalid_request'});
 for(const a of [{nameContains:''},{nameContains:'x'.repeat(257)},{nameContains:'x',q:'fullText contains secret'}])await expect(c.driveSearchFiles(a)).rejects.toMatchObject({status:400});expect(b).not.toHaveBeenCalled();expect(f).not.toHaveBeenCalled();
});
it.each([401,403,404,429,500])('preserves status %i without private provider text',async(s)=>{
 const c=driveRestClient(vi.fn(async()=>Response.json({error:{message:'PRIVATE_CANARY'}},{status:s})),async()=> 'fixture');
 await expect(c.driveListFiles({})).rejects.toMatchObject({status:s,code:s===401?'drive_auth_failed':s===403?'drive_access_denied':s===404?'drive_not_found':s===429?'drive_rate_limited':'drive_read_failed'});
 try{await c.driveListFiles({});}catch(e){expect(String(e)).not.toContain('PRIVATE_CANARY');}
});
it('malformed and excessive provider output fails closed',async()=>{
 for(const d of [{files:[{name:'missing id',mimeType:'text/plain'}]},{files:Array.from({length:11},()=>({id:'f',name:'x',mimeType:'text/plain'}))},{files:[],nextPageToken:'x'.repeat(2049)}])await expect(driveRestClient(vi.fn(async()=>Response.json(d)),async()=> 'fixture').driveListFiles({})).rejects.toMatchObject({status:502,code:'drive_invalid_response'});
});

it('only structured provider evidence identifies scope or disabled service',async()=>{
 for(const [details,code] of [[[{reason:'insufficientPermissions'}],'drive_scope_missing'],[[{reason:'accessNotConfigured'}],'drive_service_disabled']] as const){
  const c=driveRestClient(vi.fn(async()=>Response.json({error:{message:'PRIVATE',errors:details}},{status:403})),async()=> 'fixture');
  await expect(c.driveListFiles({})).rejects.toMatchObject({status:403,code});
 }
 const c=driveRestClient(vi.fn(async()=>Response.json({error:{status:'PERMISSION_DENIED',message:'PRIVATE',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'googleapis.com',reason:'SERVICE_DISABLED',metadata:{service:'drive.googleapis.com',consumer:'PRIVATE'}}]}},{status:403})),async()=> 'fixture');
 await expect(c.driveListFiles({})).rejects.toMatchObject({status:403,code:'drive_service_disabled',reason:'SERVICE_DISABLED',service:'drive.googleapis.com'});
});
it.each([401,403])('non-JSON provider error %i keeps status and safe code',async status=>{
 const c=driveRestClient(vi.fn(async()=>new Response('PRIVATE_CANARY',{status})),async()=> 'fixture');
 await expect(c.driveListFiles({})).rejects.toMatchObject({status,code:status===401?'drive_auth_failed':'drive_access_denied'});
});
it('oversized provider body is stopped and safe failures never expose raw content',async()=>{
 const c=driveRestClient(vi.fn(async()=>new Response('PRIVATE_CANARY'.repeat(12000))),async()=> 'fixture');
 await expect(c.driveListFiles({})).rejects.toMatchObject({status:502,code:'drive_invalid_response'});
});
it('empty API list can omit its repeated files field',async()=>{
 const c=driveRestClient(vi.fn(async()=>Response.json({})),async()=> 'fixture');
 expect(await c.driveListFiles({})).toEqual({files:[],nextPageToken:null,incompleteSearch:false});
});
it.each([401,403])('body-stream failure after HTTP %i keeps known status',async status=>{
 const c=driveRestClient(vi.fn(async()=>new Response(new ReadableStream({start(c){c.error(new Error('PRIVATE_CANARY'));}}),{status})),async()=> 'fixture');
 await expect(c.driveListFiles({})).rejects.toMatchObject({status,code:status===401?'drive_auth_failed':'drive_access_denied'});
});
it('HTTP200 error envelope never becomes an empty success',async()=>{
 const c=driveRestClient(vi.fn(async()=>Response.json({error:{message:'PRIVATE_CANARY'}})),async()=> 'fixture');
 await expect(c.driveListFiles({})).rejects.toMatchObject({status:502,code:'drive_invalid_response'});
});
