import {expect,it} from 'vitest';
import {LIMITS} from '@waldo/workspace';
import {browserHttpAttachment} from '../src/channels/browser-http-attachment';
const response=(headers:Record<string,string>,status=200)=>({headers:()=>headers,status:()=>status}) as never;
it('captures filename, decoded bytes and hash without publishing credential headers',async()=>{
 const bytes=new TextEncoder().encode('fictional,csv\n');
 const result=await browserHttpAttachment(response({'content-disposition':"attachment; filename*=UTF-8''report%20name.csv",'content-type':'text/csv; charset=utf-8','set-cookie':'PRIVATE_CREDENTIAL'}),async()=>bytes);
 expect(result.metadata).toMatchObject({filename:'report name.csv',mime:'text/csv',byte_size:bytes.length,sha256:expect.stringMatching(/^[a-f0-9]{64}$/)});expect(JSON.stringify(result)).not.toContain('PRIVATE_CREDENTIAL');
});
it.each(['missing','inline','path','declared_oversize','bad_length','status'] as const)('refuses %s before reading body',async mode=>{
 let reads=0;const headers={'content-disposition':'attachment; filename="report.csv"',...(mode==='missing'?{'content-disposition':''}:{}),...(mode==='inline'?{'content-disposition':'inline; filename="report.csv"'}:{}),...(mode==='path'?{'content-disposition':'attachment; filename="../secret.csv"'}:{}),...(mode==='declared_oversize'?{'content-length':String(LIMITS.fileBytes+1)}:{}),...(mode==='bad_length'?{'content-length':'not-a-size'}:{})};
 await expect(browserHttpAttachment(response(headers,mode==='status'?403:200),async()=>{reads++;return new Uint8Array([1]);})).rejects.toThrow('browser_download_');expect(reads).toBe(0);
});
it('rejects an undeclared oversized buffered body instead of presenting metadata as completion',async()=>{
 await expect(browserHttpAttachment(response({'content-disposition':'attachment'}),async()=>new Uint8Array(LIMITS.fileBytes+1))).rejects.toMatchObject({code:'oversize'});
});
