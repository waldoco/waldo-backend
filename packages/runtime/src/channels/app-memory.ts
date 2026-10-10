import { APP_MEMORY_CORRECTION_MAX_REQUEST_BYTES, appMemoryCorrectionV1Schema, appMemoryCorrectionReceiptV1Schema, appMemoryCorrectionTargetsV1Schema, type AppMemoryCorrectionReceiptV1 } from '../../../contracts/src/app/memory';
import { normalizeForGrounding, textFingerprint, type Claim, type ClaimStore } from '../memory/claims';
import { carriesTopic, hidesTopic } from '../memory/forget-guard';
import { rightsDigest } from '../rights/capability';
import { RightsError } from '../rights/jobs';

export type AppMemoryCorrectionHost = Readonly<{
  ownerRef:string; scope:string; sessionHash:string;
  storage:Pick<DurableObjectStorage['kv'],'get'|'put'>; store:ClaimStore;
  assertCurrent():Promise<void>; rateLimit():Promise<boolean>;
  commit<T>(work:()=>T):T; now():number;
  // In the same commit, invalidate composed context/source epochs after correction.
  changed?():void;
}>;
type Operation = {owner:string;scope:string;session:string;digest:string;receipt:AppMemoryCorrectionReceiptV1};
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const json=(value:object,status=200)=>Response.json(value,{status,headers});
const claimRef=(scope:string,id:number)=>`${scope}:claim:${id}`;
const canonicalClaim=(claim:Claim)=>JSON.stringify([
  claim.id,claim.kind,claim.text,claim.source,claim.evidence,claim.origin??null,claim.status,
  claim.created_at,claim.last_seen_at,claim.seen_count,claim.source_ref??null,claim.learned_at??null,
  claim.valid_from??null,claim.valid_to??null,claim.supersedes_id??null,claim.verification_status??null,
  (claim as Claim&{aliases?:string|null}).aliases??null,
]);
export const appMemoryCorrectionRevision=(ownerRef:string,scope:string,claim:Claim)=>rightsDigest(JSON.stringify([ownerRef,scope,canonicalClaim(claim)]));
const hidden=(host:AppMemoryCorrectionHost,claim:Claim)=>[...host.store.pendingTopics(),...host.store.incompleteTopics()].some(topic=>[claim.text,claim.evidence,claim.source_ref,(claim as Claim&{aliases?:string|null}).aliases].some(text=>typeof text==='string'&&(carriesTopic(text,topic)||hidesTopic(text,topic))));
const active=(host:AppMemoryCorrectionHost,claim:Claim)=>claim.status==='active'&&!claim.valid_to&&claim.origin!=='untrusted'&&!hidden(host,claim);
export const appMemoryCorrectionTargets=async(host:AppMemoryCorrectionHost)=>{
  await host.assertCurrent();const rows=host.store.claims().filter(claim=>active(host,claim));
  const targets=await Promise.all(rows.slice(0,200).map(async claim=>({claim_ref:claimRef(host.scope,claim.id),revision:await appMemoryCorrectionRevision(host.ownerRef,host.scope,claim)})));
  await host.assertCurrent();return appMemoryCorrectionTargetsV1Schema.parse({version:'memory-correction.v1',targets,truncated:rows.length>200});
};
const read=async(request:Request)=>{
  if(!(request.headers.get('content-type')??'').toLowerCase().startsWith('application/json')||!request.body)throw new RightsError('invalid');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0,expired=false;
  const timer=setTimeout(()=>{expired=true;void reader.cancel();},5000);
  try{while(true){const part=await reader.read();if(expired)throw new RightsError('unavailable');if(part.done)break;size+=part.value.byteLength;if(size>APP_MEMORY_CORRECTION_MAX_REQUEST_BYTES){await reader.cancel();throw new RightsError('invalid');}chunks.push(part.value);}}
  finally{clearTimeout(timer);reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{throw new RightsError('invalid');}
  const parsed=appMemoryCorrectionV1Schema.safeParse(raw);if(!parsed.success)throw new RightsError('invalid');return parsed.data;
};
const queues=new WeakMap<object,Promise<unknown>>();
const serialized=async<T>(storage:object,work:()=>Promise<T>)=>{const next=(queues.get(storage)??Promise.resolve()).catch(()=>undefined).then(work);queues.set(storage,next);try{return await next;}finally{if(queues.get(storage)===next)queues.delete(storage);}};
const receipt=(host:AppMemoryCorrectionHost,row:Operation)=>{
  if(row.owner!==host.ownerRef||row.scope!==host.scope||row.session!==host.sessionHash)throw new RightsError('rejected');
  return appMemoryCorrectionReceiptV1Schema.parse(row.receipt);
};
// The authenticated app host selects owner/DO/session and owns the synchronized
// commit. A model extractor, supplied account label or unrelated channel cannot
// authorize this explicit owner correction.
export const appMemoryCorrectionRequest=async(request:Request,host:AppMemoryCorrectionHost):Promise<Response|null>=>{
  const url=new URL(request.url),path=url.pathname;if(path!=='/app/v1/memory/corrections'&&!path.startsWith('/app/v1/memory/corrections/'))return null;
  try{
    if(url.search||!host.ownerRef||!host.scope||!/^[a-f0-9]{64}$/.test(host.sessionHash))throw new RightsError('invalid');
    const origin=request.headers.get('origin');if(request.method!=='GET'&&origin!==null&&origin!==url.origin)throw new RightsError('rejected');
    if(!await host.rateLimit())return json({error:'rate_limited'},429);await host.assertCurrent();
    if(path==='/app/v1/memory/corrections/targets'&&request.method==='GET')return json(await appMemoryCorrectionTargets(host));
    if(path!=='/app/v1/memory/corrections'){
      const id=path.slice('/app/v1/memory/corrections/'.length);if(request.method!=='GET'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw new RightsError('invalid');
      const row=host.storage.get<Operation>(`app:memory.correction:${id}`);if(!row)throw new RightsError('not_found');const shown=receipt(host,row);await host.assertCurrent();return json(shown);
    }
    if(request.method!=='POST')return json({error:'method'},405);
    const args=await read(request);
    return await serialized(host.storage,async()=>{
      await host.assertCurrent();const digest=await rightsDigest(JSON.stringify(args)),key=`app:memory.correction:${args.operation_id}`;
      await host.assertCurrent();const prior=host.storage.get<Operation>(key);if(prior){const shown=receipt(host,prior);if(prior.digest!==digest)throw new RightsError('conflict');return json(shown);}
      const selected=host.store.claims().find(claim=>claimRef(host.scope,claim.id)===args.claim_ref&&active(host,claim));if(!selected)throw new RightsError('not_found');
      const before=canonicalClaim(selected);if(await appMemoryCorrectionRevision(host.ownerRef,host.scope,selected)!==args.expected_revision)throw new RightsError('conflict');
      const occurrence=`app-memory-correction:${await rightsDigest(JSON.stringify([host.ownerRef,host.scope,args.operation_id]))}`;
      await host.assertCurrent();
      const saved=host.commit(()=>{
        // Re-read exact row inside the same transaction as correction and receipt.
        const current=host.store.claims().find(claim=>claim.id===selected.id);
        if(!current||!active(host,current)||canonicalClaim(current)!==before)throw new RightsError('conflict');
        const forms=[args.text,args.text.trim(),args.text.trim().toLowerCase().replace(/\s+/g,' ')];
        if(host.store.barriers().some(barrier=>forms.some(text=>barrier.topic_hash===textFingerprint(text)))||[...host.store.pendingTopics(),...host.store.incompleteTopics()].some(topic=>carriesTopic(args.text,topic)||hidesTopic(args.text,topic)))throw new RightsError('rejected');
        const twin=host.store.claims().find(claim=>claim.id!==selected.id&&normalizeForGrounding(claim.text)===normalizeForGrounding(args.text));
        // Reusing a duplicate must not silently adopt different kind/provenance or
        // replace another owner's occurrence metadata with this submission.
        if(twin&&(twin.kind!==args.kind||twin.origin!=='owner'||twin.source!=='stated'||!active(host,twin)))throw new RightsError('conflict');
        const at=host.now();if(!Number.isSafeInteger(at)||at<0)throw new RightsError('unavailable');
        if(!host.store.correct(selected.id,{kind:args.kind,text:args.text,source:'stated',origin:'owner',evidence:args.text,source_ref:`owner, ${occurrence}`},new Date(at).toISOString()))throw new RightsError('conflict');
        const replacement=twin??host.store.claims().find(claim=>claim.supersedes_id===selected.id&&claim.source_ref===`owner, ${occurrence}`&&claim.kind===args.kind&&claim.text===args.text&&claim.evidence===args.text&&claim.source==='stated'&&claim.origin==='owner');
        if(!replacement||!active(host,replacement))throw new RightsError('unavailable');
        const result=appMemoryCorrectionReceiptV1Schema.parse({version:'memory-correction.v1',operation_id:args.operation_id,state:'recorded',previous_claim_ref:args.claim_ref,replacement_claim_ref:claimRef(host.scope,replacement.id),expected_revision:args.expected_revision,occurrence_ref:occurrence,recorded_at:at,source:'explicit_owner',authority:'context_only_not_action_approval'});
        host.changed?.();host.storage.put(key,{owner:host.ownerRef,scope:host.scope,session:host.sessionHash,digest,receipt:result} satisfies Operation);return result;
      });
      await host.assertCurrent();return json(saved);
    });
  }catch(error){const code=error instanceof RightsError?error.code:'unavailable';return json({error:`memory_${code}`},code==='invalid'?400:code==='rejected'?403:code==='conflict'?409:code==='not_found'?404:503);}
};
