import {LIMITS,validId,validatePath,type FileMeta} from '@waldo/workspace';
import type {BrowserSession} from '@waldo/contracts';
import type {GeneralActionSnapshot} from './general-browser-observation';
import {generalDigest} from './general-browser-observation';
import type {workspaceOwnerHost} from './workspace-host';

type UploadFile=Pick<FileMeta,'file_id'|'revision'|'path'|'mime'|'byte_size'|'sha256'|'state'>;
export type BrowserUploadBinding=Readonly<{version:1;operationId:string;ownerId:string;sessionHandle:string;generation:number;documentDigest:string;documentRevision:string;elementRef:string;fileId:string;revision:number;filename:string;mime:string;byteSize:number;sha256:string;destination:string;expiresAt:number}>;

// Host-authored approval metadata: input selection can immediately send bytes.
// This binding is not an approval grant; the existing approval ledger owns consent.
export function browserUploadBinding(options:Readonly<{session:BrowserSession;snapshot:GeneralActionSnapshot;elementRef:string;file:UploadFile;operationId:string;now:number}>):BrowserUploadBinding{
 const {session,snapshot,file}=options;
 if(!validId(options.operationId)||snapshot.ownerId!==session.ownerId||snapshot.sessionId!==session.id||snapshot.generation!==session.generation||session.expiresAt<=options.now||!snapshot.digest||!snapshot.observation.revision)throw Error('browser_upload_rejected');
 const index=snapshot.observation.elements.findIndex(element=>element.ref===options.elementRef),element=snapshot.state.elements[index];
 if(!element||element.disabled||element.tag!=='input'||element.type!=='file'||!element.inForm||element.formMethod?.toLowerCase()!=='post'||!element.formAction)throw Error('browser_upload_rejected');
 const destination=new URL(element.formAction),page=new URL(snapshot.observation.url);
 if(destination.protocol!=='https:'||destination.origin!==page.origin||destination.username||destination.password||destination.hash)throw Error('browser_upload_rejected');
 validatePath(file.path);const filename=file.path.split('/').at(-1)!;
 if(!validId(file.file_id)||file.state!=='ready'||!Number.isSafeInteger(file.revision)||file.revision<1||!Number.isSafeInteger(file.byte_size)||file.byte_size<1||file.byte_size>LIMITS.fileBytes||!/^[a-f0-9]{64}$/.test(file.sha256)||!file.mime)throw Error('browser_upload_rejected');
 return {version:1,operationId:options.operationId,ownerId:session.ownerId,sessionHandle:session.id,generation:session.generation,documentDigest:snapshot.digest,documentRevision:snapshot.observation.revision,elementRef:options.elementRef,fileId:file.file_id,revision:file.revision,filename,mime:file.mime,byteSize:file.byte_size,sha256:file.sha256,destination:destination.href,expiresAt:session.expiresAt};
}

// Read approved exact-revision bytes with fresh owner custody. The caller commits
// uncertain/exposed intent before select; neither this helper nor recovery resends.
export async function browserUploadBytes(options:Readonly<{binding:BrowserUploadBinding;session:BrowserSession;snapshot:GeneralActionSnapshot;workspace:Awaited<ReturnType<typeof workspaceOwnerHost>>;now():number;assertCurrent():Promise<void>;beforeExposure():Promise<void>;select(file:Readonly<{name:string;mimeType:string;buffer:Uint8Array}>):Promise<void>}>):Promise<void>{
 const deadline=Math.min(options.binding.expiresAt,options.session.expiresAt),duration=deadline-options.now();
 if(!Number.isSafeInteger(duration)||duration<1||duration>2147483647)throw Error('browser_upload_expired');
 let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
 const interrupted=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('browser_upload_expired'));},duration);});
 const checked=async()=>{if(expired||options.now()>=deadline)throw Error('browser_upload_expired');await options.assertCurrent();if(expired||options.now()>=deadline)throw Error('browser_upload_expired');};
 const step=async<T>(run:()=>Promise<T>)=>{await Promise.race([checked(),interrupted]);return Promise.race([Promise.resolve().then(()=>{if(expired||options.now()>=deadline)throw Error('browser_upload_expired');return run();}),interrupted]);};
 try{
  const retrieved=await step(()=>options.workspace.export(options.binding.fileId,options.binding.revision,LIMITS.fileBytes));
  const expected=browserUploadBinding({session:options.session,snapshot:options.snapshot,elementRef:options.binding.elementRef,file:retrieved.meta,operationId:options.binding.operationId,now:options.now()});
  if(Object.keys(options.binding).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>options.binding[key as keyof BrowserUploadBinding]!==value)||retrieved.bytes.length!==expected.byteSize||await step(()=>generalDigest(retrieved.bytes))!==expected.sha256)throw Error('browser_upload_binding_changed');
  await step(options.beforeExposure);
  await step(()=>options.select({name:expected.filename,mimeType:expected.mime,buffer:new Uint8Array(retrieved.bytes)}));
 }finally{if(timer!==undefined)clearTimeout(timer);}
}
