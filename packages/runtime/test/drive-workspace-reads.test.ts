import {expect,it,vi} from 'vitest';
import {buildSessionState, readDriveArgsSchema} from '@waldo/contracts';
import {driveRestClient} from '../src/connectors/drive-rest';
import {readDriveHandler} from '../src/tools/live/drive';
import {sanitise} from '../src/scribe/sanitiser';
import type {GoogleClient} from '../src/connectors/google';

const id='sheet_1234567890';const at='2026-10-03T10:00:00Z';
const content=(mimeType:string,body:string,type:string)=>{
 const urls:URL[]=[];
 const fetcher=vi.fn(async(raw:RequestInfo|URL)=>{const url=new URL(String(raw));urls.push(url);
  if(url.searchParams.has('fields'))return Response.json({id,name:'Budget',mimeType,modifiedTime:at,version:'4',capabilities:{canDownload:true}});
  return new Response(body,{headers:{'content-type':`${type}; charset=utf-8`}});});
 return {client:driveRestClient(fetcher,async()=> 'fixture'),urls};
};

it('a Google Sheet reads as CSV of its first sheet through the Drive export',async()=>{
 const f=content('application/vnd.google-apps.spreadsheet','Month,Spend\nJan,120\n','text/csv');
 expect(await f.client.driveReadFileContent({fileId:id,expectedModifiedTime:at})).toMatchObject({text:'Month,Spend\nJan,120\n',contentMimeType:'text/csv',truncated:false});
 expect(f.urls[1]!.pathname).toBe(`/drive/v3/files/${id}/export`);
 expect(f.urls[1]!.searchParams.get('mimeType')).toBe('text/csv');
});

it('Google Slides read as text through the Drive export',async()=>{
 const f=content('application/vnd.google-apps.presentation','Q3 review\nRevenue up','text/plain');
 expect(await f.client.driveReadFileContent({fileId:id,expectedModifiedTime:at})).toMatchObject({text:'Q3 review\nRevenue up',contentMimeType:'text/plain'});
 expect(f.urls[1]!.searchParams.get('mimeType')).toBe('text/plain');
});

it('a Sheet export that answers with another type is never taken as its contents',async()=>{
 const f=content('application/vnd.google-apps.spreadsheet','<html>Login</html>','text/html');
 await expect(f.client.driveReadFileContent({fileId:id,expectedModifiedTime:at})).rejects.toMatchObject({code:'drive_invalid_response'});
});

it('search matches names and text inside files, across shared drives, in relevance order',async()=>{
 const f=vi.fn(async()=>Response.json({files:[]}));
 await driveRestClient(f,async()=> 'fixture').driveSearchFiles({nameContains:"O'Reilly budget"});
 const u=new URL((f.mock.calls[0] as unknown as [string])[0]);
 expect(u.searchParams.get('q')).toBe("trashed = false and (name contains 'O\\'Reilly budget' or fullText contains 'O\\'Reilly budget')");
 expect(u.searchParams.get('orderBy')).toBeNull();
 expect(u.searchParams.get('corpora')).toBe('allDrives');
 expect(u.searchParams.get('includeItemsFromAllDrives')).toBe('true');
 expect(u.searchParams.get('supportsAllDrives')).toBe('true');
});

it('recent files and single-file reads include shared drives',async()=>{
 const f=vi.fn(async(raw:RequestInfo|URL)=>new URL(String(raw)).pathname.endsWith('/files')?Response.json({files:[]}):Response.json({id:'f_1',name:'R',mimeType:'text/plain'}));
 const c=driveRestClient(f,async()=> 'fixture');
 await c.driveListFiles({});await c.driveGetFileMetadata({fileId:'f_1'});
 const [list,get]=f.mock.calls.map(call=>new URL(String((call as unknown as [string])[0])));
 expect(list!.searchParams.get('corpora')).toBe('allDrives');expect(list!.searchParams.get('orderBy')).toBe('recency desc');
 expect(get!.searchParams.get('supportsAllDrives')).toBe('true');
});

it('the read_drive tool hands Sheet CSV to the model and says it is the first sheet',async()=>{
 const file={id,name:'Budget',mimeType:'application/vnd.google-apps.spreadsheet',modifiedTime:at,webViewLink:null,size:null};
 const account={connection_id:'selected',email:null};
 const result={file,text:'Month,Spend\nJan,120\n',contentMimeType:'text/csv' as const,version:'4',truncated:false,returnedBytes:20,observedAt:at};
 const h=readDriveHandler({client:async()=>({account,driveReadFileContent:async()=>result}) as unknown as GoogleClient},true,true);
 expect(h.description).toContain('first sheet');
 const ctx={authenticatedUserId:'owner',turnId:'t',trigger:'user_message' as const,session:buildSessionState({trigger:'user_message',canary_tokens:['1111111111111111','2222222222222222','3333333333333333'],started_at:1}),hasApproval:()=>false,sourceTaint:null,toolArgSourceTaint:null,sanitise};
 const out=await h.handle(readDriveArgsSchema.parse({action:'content',file_id:id,connection_id:'selected',expected_modified_time:at}),ctx as never);
 expect(out).toMatchObject({ok:true,data:{contentMimeType:'text/csv',text:'Month,Spend\nJan,120\n'}});
});
