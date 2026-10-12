import { ARTIFACT_BODY_MAX_CHARS } from '@waldo/contracts';
import {renderArtifactBody} from './rich-format';
import {resultCard,standalonePage,wantsHtml} from './standalone-page';
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
  return {status:'owner_link',url:`${base}${ARTIFACT_PATH}/${encodeURIComponent(meta.id)}?revision=${meta.revision}`,audience:'owner_authenticated'};
};
const headers = {'cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const ARTIFACT_FAILURE:Readonly<Record<number,string>>={404:'Artifact not found.',405:'Not available.',409:'This link is out of date.',413:'Artifact too large.',503:'Temporarily unavailable.'};
const esc=(value:string)=>value.replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
// Called only AFTER the console host validates the owner session and selects its DO.
export const artifactPage=async(request:Request, book:ArtifactBook):Promise<Response|null>=>{
 const url=new URL(request.url);if(!url.pathname.startsWith(`${ARTIFACT_PATH}/`))return null;
 // Browser navigations see the same refusal as a page; it never reflects the requested ID.
 const fail=(text:string,status:number)=>wantsHtml(request.headers.get('accept'))?new Response(standalonePage({title:'Artifact · Waldo',layout:'card',home:true,body:resultCard({tone:'negative',title:ARTIFACT_FAILURE[status]??'Artifact unavailable.',body:`<p>${esc(text.charAt(0).toUpperCase()+text.slice(1))}.</p>`,actions:'<a class="button-link" href="/console">Back to dashboard</a>'})}),{status,headers:{...headers,'content-type':'text/html; charset=utf-8'}}):new Response(text,{status,headers});
 if(request.method!=='GET')return fail('method not allowed',405);
 let id:string;try{id=decodeURIComponent(url.pathname.slice(ARTIFACT_PATH.length+1));}catch{return fail('not found',404);}
 if(!/^art:[a-zA-Z0-9_-]{1,128}$/.test(id))return fail('not found',404);
 const requested=url.searchParams.get('revision');
 if(requested!==null && !/^[1-9][0-9]{0,8}$/.test(requested))return fail('not found',404);
 const first=await book.read(id,0,ARTIFACT_BODY_MAX_CHARS+1);if(!first)return fail('not found',404);
 if(requested!==null && Number(requested)!==first.meta.revision)return fail('revision changed; ask Waldo for the current link',409);
 if(first.total_chars>ARTIFACT_BODY_MAX_CHARS)return fail('artifact too large',413);
 if(first.next_offset!==null || first.text.length>ARTIFACT_BODY_MAX_CHARS || first.text.length!==first.total_chars)return fail('temporarily unavailable',503);
 if(book.byId(id)?.revision!==first.meta.revision)return fail('revision changed; ask Waldo for the current link',409);
 return new Response(standalonePage({title:first.meta.name,layout:'reading',body:`<div class="page-heading"><span class="label">Private artifact · revision ${first.meta.revision}</span><h1>${esc(first.meta.name)}</h1></div><article class="tile">${renderArtifactBody(first.meta.kind,first.text)}</article>`}),{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
};

export const artifactReadAdmission = async (limiter: RateLimit|undefined, ownerScope:string):Promise<Response|null> => {
 if(!limiter)return new Response('temporarily unavailable',{status:503,headers});
 try { if(!(await limiter.limit({key:`artifact-read:${ownerScope}`})).success)return new Response('too many requests',{status:429,headers}); }
 catch { return new Response('temporarily unavailable',{status:503,headers}); }
 return null;
};
