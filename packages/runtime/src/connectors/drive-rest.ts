// Metadata-only Drive v3 reads. Callers supply their existing authenticated grant refresh path.
export type DriveFileMetadata = Readonly<{id:string;name:string;mimeType:string;modifiedTime:string|null;webViewLink:string|null;size:string|null}>;
export type DriveMetadataPage = Readonly<{files:readonly DriveFileMetadata[];nextPageToken:string|null;incompleteSearch:boolean}>;
export type DrivePageArgs = Readonly<{pageSize?:number;pageToken?:string}>;
export type DriveSearchArgs = DrivePageArgs & Readonly<{nameContains:string}>;
export type DriveGetArgs = Readonly<{fileId:string}>;
export type DriveRestClient = Readonly<{
 driveListFiles(args:DrivePageArgs):Promise<DriveMetadataPage>;
 driveSearchFiles(args:DriveSearchArgs):Promise<DriveMetadataPage>;
 driveGetFileMetadata(args:DriveGetArgs):Promise<DriveFileMetadata>;
}>;
export const DRIVE_REST_METHODS = ['driveListFiles','driveSearchFiles','driveGetFileMetadata'] as const;
export type DriveRestMethod = typeof DRIVE_REST_METHODS[number];
type DriveErrorCode = 'drive_invalid_request'|'drive_invalid_response'|'drive_auth_failed'|'drive_access_denied'|'drive_scope_missing'|'drive_service_disabled'|'drive_not_found'|'drive_rate_limited'|'drive_read_failed';
export class DriveRestError extends Error {
 constructor(readonly status:number,readonly code:DriveErrorCode,readonly reason?:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'|'SERVICE_DISABLED',readonly service?:'drive.googleapis.com'){super(code);}
}
const object = (value:unknown):value is Record<string,unknown> => value!==null && typeof value==='object' && !Array.isArray(value);
const text = (value:unknown,max:number):value is string => typeof value==='string' && value.length>0 && value.length<=max;
const invalid = ():never => {throw new DriveRestError(400,'drive_invalid_request');};
const httpFailure = (status:number):never => {throw new DriveRestError(status,status===401?'drive_auth_failed':status===403?'drive_access_denied':status===404?'drive_not_found':status===429?'drive_rate_limited':'drive_read_failed');};
const malformed = ():never => {throw new DriveRestError(502,'drive_invalid_response');};
const argsObject = (value:unknown,keys:readonly string[]) => {
 if(!object(value)||Object.keys(value).some(key=>!keys.includes(key)))return invalid();
 return value;
};
const pageArgs = (value:unknown,search=false) => {
 const args=argsObject(value,search?['pageSize','pageToken','nameContains']:['pageSize','pageToken']);
 const pageSize=args.pageSize===undefined?10:args.pageSize;
 if(typeof pageSize!=='number'||!Number.isInteger(pageSize)||pageSize<1||pageSize>50)return invalid();
 if(args.pageToken!==undefined&&!text(args.pageToken,2048))return invalid();
 if(search&&(!text(args.nameContains,256)||!args.nameContains.trim()))return invalid();
 return {pageSize,pageToken:args.pageToken as string|undefined,nameContains:args.nameContains as string|undefined};
};
const FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,size';
const ROOT = 'https://www.googleapis.com/drive/v3/files';
const file = (value:unknown):DriveFileMetadata => {
 if(!object(value)||!text(value.id,256)||!text(value.name,1024)||!text(value.mimeType,256))return malformed();
 if(value.modifiedTime!==undefined&&(!text(value.modifiedTime,64)||!Number.isFinite(Date.parse(value.modifiedTime))))return malformed();
 if(value.webViewLink!==undefined){
  if(!text(value.webViewLink,4096))return malformed();
  let url:URL;try{url=new URL(value.webViewLink);}catch{return malformed();}
  if(url.protocol!=='https:'||!['drive.google.com','docs.google.com'].includes(url.hostname)||url.username||url.password)return malformed();
 }
 if(value.size!==undefined&&(typeof value.size!=='string'||!/^\d{1,30}$/.test(value.size)))return malformed();
 return {id:value.id,name:value.name,mimeType:value.mimeType,modifiedTime:(value.modifiedTime as string|undefined)??null,webViewLink:(value.webViewLink as string|undefined)??null,size:(value.size as string|undefined)??null};
};
export const driveRestClient = (fetcher:typeof fetch,bearer:()=>Promise<string>):DriveRestClient => {
 const read = async(url:URL):Promise<unknown> => {
  let providerFailure:number|undefined;
  try{
   const token=await bearer();
   const response=await fetcher(url.toString(),{method:'GET',redirect:'error',headers:{authorization:`Bearer ${token}`}});
   if(!response.ok)providerFailure=response.status;

   // Bound the body as well as its projected fields; no raw provider body survives a failed parse.
   if(!response.body){if(!response.ok)return httpFailure(response.status);return malformed();}
   const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>128*1024){await reader.cancel();if(!response.ok)return httpFailure(response.status);return malformed();}chunks.push(value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   let data:unknown;try{data=JSON.parse(new TextDecoder().decode(bytes));}catch{
    if(!response.ok)return httpFailure(response.status);
    return malformed();
   }
   if(!response.ok){
    const error=object(data)&&object(data.error)?data.error:undefined;
    const info=Array.isArray(error?.details)?error.details.find(detail=>object(detail)&&detail['@type']==='type.googleapis.com/google.rpc.ErrorInfo'&&detail.domain==='googleapis.com'):undefined;
    const legacy=Array.isArray(error?.errors)?error.errors.filter(object).map(item=>item.reason):[];
    const reason=object(info)&&info.reason==='ACCESS_TOKEN_SCOPE_INSUFFICIENT'||legacy.includes('insufficientPermissions')?'ACCESS_TOKEN_SCOPE_INSUFFICIENT':object(info)&&info.reason==='SERVICE_DISABLED'||legacy.includes('accessNotConfigured')?'SERVICE_DISABLED':undefined;
    const service=object(info)&&object(info.metadata)&&info.metadata.service==='drive.googleapis.com'?'drive.googleapis.com':undefined;
    throw new DriveRestError(response.status,response.status===401?'drive_auth_failed':response.status===403?reason==='ACCESS_TOKEN_SCOPE_INSUFFICIENT'?'drive_scope_missing':reason==='SERVICE_DISABLED'?'drive_service_disabled':'drive_access_denied':response.status===404?'drive_not_found':response.status===429?'drive_rate_limited':'drive_read_failed',reason,service);
   }
   if(object(data)&&Object.hasOwn(data,'error'))return malformed();
   return data;
  }catch(error){if(error instanceof DriveRestError)throw error;if(providerFailure!==undefined)return httpFailure(providerFailure);throw new DriveRestError(502,'drive_read_failed');}
 };
 const list = async(value:unknown,search:boolean):Promise<DriveMetadataPage> => {
  const args=pageArgs(value,search);const url=new URL(ROOT);
  const escaped=args.nameContains?.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  url.search=new URLSearchParams({spaces:'drive',corpora:'user',q:`trashed = false${search?` and name contains '${escaped}'`:''}`,orderBy:'recency desc',pageSize:String(args.pageSize),fields:`nextPageToken,incompleteSearch,files(${FIELDS})`,...(args.pageToken?{pageToken:args.pageToken}:{})}).toString();
  const data=await read(url);if(!object(data))return malformed();
  const files=data.files===undefined?[]:data.files;
  if(!Array.isArray(files)||files.length>args.pageSize)return malformed();
  if(data.nextPageToken!==undefined&&!text(data.nextPageToken,2048))return malformed();
  if(data.incompleteSearch!==undefined&&typeof data.incompleteSearch!=='boolean')return malformed();
  return {files:files.map(file),nextPageToken:(data.nextPageToken as string|undefined)??null,incompleteSearch:data.incompleteSearch===true};
 };
 return {
  driveListFiles:args=>list(args,false),
  driveSearchFiles:args=>list(args,true),
  driveGetFileMetadata:async value=>{
   const args=argsObject(value,['fileId']);if(!text(args.fileId,256)||!/^[-_a-zA-Z0-9]+$/.test(args.fileId))return invalid();
   const url=new URL(`${ROOT}/${encodeURIComponent(args.fileId)}`);url.search=new URLSearchParams({fields:FIELDS}).toString();
   return file(await read(url));
  },
 };
};
