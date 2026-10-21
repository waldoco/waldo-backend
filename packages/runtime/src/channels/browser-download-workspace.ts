import {LIMITS,validId,validatePath} from '@waldo/workspace';
import type {workspaceOwnerHost} from './workspace-host';
import {generalDigest} from './general-browser-observation';
import {workspaceDelivery} from './workspace-delivery';

export type BrowserDownloadMetadata=Readonly<{filename:string;mime:string;byte_size:number;sha256:string}>;
export type BrowserDownloadReceipt=BrowserDownloadMetadata&Readonly<{file_id:string;revision:number;provenance:'provider_import';url:string;audience:'owner_authenticated';retrieval:'verified'}>;
export class BrowserDownloadError extends Error {
 constructor(readonly code:'rejected'|'oversize'|'integrity_unavailable'|'unavailable'){super(`browser_download_${code}`);}
}

// Recover by the workspace operation receipt, never by clicking or fetching again.
export async function browserDownloadToWorkspace(options:Readonly<{
 workspace:Awaited<ReturnType<typeof workspaceOwnerHost>>;operationId:string;origin:string;
 metadata:BrowserDownloadMetadata;bytes?:Uint8Array;deadline:number;now():number;assertCurrent():Promise<void>;
}>):Promise<BrowserDownloadReceipt>{
 const {metadata}=options;
 let timer:ReturnType<typeof setTimeout>|undefined,expired=false;
 const duration=options.deadline-options.now();
 if(!Number.isSafeInteger(duration)||duration<1||duration>2147483647)throw new BrowserDownloadError('rejected');
 try{
  if(!validId(options.operationId)||!metadata.filename||metadata.filename.includes('/')||metadata.filename.includes('\\')||!Number.isSafeInteger(metadata.byte_size)||metadata.byte_size<1||!/^[a-f0-9]{64}$/.test(metadata.sha256))throw new BrowserDownloadError('rejected');
  const path=`browser-downloads/${options.operationId}/${metadata.filename}`;validatePath(path);
  if(metadata.byte_size>LIMITS.fileBytes)throw new BrowserDownloadError('oversize');
  const interrupted=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new BrowserDownloadError('unavailable'));},duration);});
  const checked=async()=>{
   if(expired||options.now()>=options.deadline)throw new BrowserDownloadError('unavailable');
   await options.assertCurrent();
   if(expired||options.now()>=options.deadline)throw new BrowserDownloadError('unavailable');
  };
  const step=async<T>(run:()=>Promise<T>)=>{
   await Promise.race([checked(),interrupted]);
   return Promise.race([Promise.resolve().then(()=>{if(expired||options.now()>=options.deadline)throw new BrowserDownloadError('unavailable');return run();}),interrupted]);
  };
  if(options.bytes&&(options.bytes.length!==metadata.byte_size||await step(()=>generalDigest(options.bytes!))!==metadata.sha256))throw new BrowserDownloadError('integrity_unavailable');
  const meta=await step(()=>options.bytes?options.workspace.write({path,bytes:options.bytes,mime:metadata.mime,provenance:'provider_import',expected_revision:0,operation_id:options.operationId}):options.workspace.reconcile(options.operationId));
  const retrieved=await step(()=>options.workspace.export(meta.file_id,meta.revision,LIMITS.fileBytes));
  if(meta.path!==path||meta.mime!==metadata.mime||meta.provenance!=='provider_import'||meta.byte_size!==metadata.byte_size||meta.sha256!==metadata.sha256||retrieved.bytes.length!==metadata.byte_size||await step(()=>generalDigest(retrieved.bytes))!==metadata.sha256)throw new BrowserDownloadError('integrity_unavailable');
  const delivery=await step(()=>workspaceDelivery(options.workspace,meta,{durable:true,origin:async()=>options.origin}));
  await Promise.race([checked(),interrupted]);
  if(delivery.status!=='owner_link'||!delivery.url||delivery.audience!=='owner_authenticated')throw new BrowserDownloadError('unavailable');
  return {...metadata,file_id:meta.file_id,revision:meta.revision,provenance:'provider_import',url:delivery.url,audience:'owner_authenticated',retrieval:'verified'};
 }catch(error){throw error instanceof BrowserDownloadError?error:new BrowserDownloadError('unavailable');}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
