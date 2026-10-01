import type { ArtifactBook, ArtifactMeta } from './artifacts';
export const ARTIFACT_PATH = '/console/artifacts';
export type ArtifactDelivery = Readonly<{status:'saved_internal'|'owner_link';url:string|null;audience:'unverified'|'owner_authenticated'}>;
export type DeliverArtifact = (meta: ArtifactMeta) => Promise<ArtifactDelivery>;
const internal: ArtifactDelivery = {status:'saved_internal',url:null,audience:'unverified'};
export const artifactDelivery = (book: ArtifactBook, origin:()=>Promise<string|null>, durable:boolean):DeliverArtifact => async(meta)=>{
  if(!durable) return internal;
  const base=await origin();
  if(!base) return internal;
  let url:URL; try{url=new URL(base);}catch{return internal;}
  if(url.protocol!=='https:' || url.origin!==base || url.username || url.password) return internal;
  const stored=await book.read(meta.id,0,1);
  if(!stored || stored.meta.revision!==meta.revision) return internal;
  return {status:'owner_link',url:`${base}${ARTIFACT_PATH}/${encodeURIComponent(meta.id)}`,audience:'owner_authenticated'};
};
const headers = {'cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const esc=(value:string)=>value.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
// Called only AFTER the console host validates the owner session and selects its DO.
export const artifactPage=async(request:Request, book:ArtifactBook):Promise<Response|null>=>{
 const url=new URL(request.url);if(!url.pathname.startsWith(`${ARTIFACT_PATH}/`))return null;
 if(request.method!=='GET')return new Response('method not allowed',{status:405,headers});
 let id:string;try{id=decodeURIComponent(url.pathname.slice(ARTIFACT_PATH.length+1));}catch{return new Response('not found',{status:404,headers});}
 if(!/^art:[a-zA-Z0-9_-]{1,128}$/.test(id))return new Response('not found',{status:404,headers});
 const first=await book.read(id,0,8000);if(!first)return new Response('not found',{status:404,headers});
 const parts=[first.text];let offset=first.next_offset;
 while(offset!==null){const next=await book.read(id,offset,8000);if(!next || next.meta.revision!==first.meta.revision || next.next_offset!==null && next.next_offset<=offset)return new Response('temporarily unavailable',{status:503,headers});parts.push(next.text);offset=next.next_offset;}
 return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(first.meta.name)}</title><style>body{margin:24px auto;padding:0 20px;max-width:760px;font:17px/1.6 system-ui;color:#222;background:#fafaf8}h1{font-size:26px;overflow-wrap:anywhere}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}small{color:#666}</style></head><body><h1>${esc(first.meta.name)}</h1><small>Private artifact · revision ${first.meta.revision}</small><pre>${esc(parts.join(''))}</pre></body></html>`,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
};
