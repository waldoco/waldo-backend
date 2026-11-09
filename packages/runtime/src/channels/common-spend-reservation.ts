// Host-supplied upper bounds, not inferred prices or owner approval. Reservations
// are never refunded on missing/uncertain receipts. Identifiers contain no input.
export type CommonSpendPolicy = Readonly<{
  ref: string; ownerId: string; validUntil: number; limitMicrousd: number; maxCalls: number;
}>;
type Reservation = Readonly<{id: string; upperBoundMicrousd: number}>;
type Cleanup = {id:string; upperBoundMicrousd:number; maxCalls:number; issued:number};
type Ledger = {policy: CommonSpendPolicy; reservedMicrousd: number; calls: Reservation[]; cleanup:Cleanup[]};
export function commonSpendReservation(storage: Pick<DurableObjectStorage,'kv'|'transactionSync'>,
  policy: CommonSpendPolicy, now: () => number, assertCurrent: () => void,assertTotal?:(additionalMicrousd:number)=>void) {
  if(!policy.ref || !policy.ownerId || !Number.isSafeInteger(policy.validUntil) ||
     !Number.isSafeInteger(policy.limitMicrousd) || policy.limitMicrousd <= 0 || !Number.isSafeInteger(policy.maxCalls) || policy.maxCalls<1) throw Error('common spend policy invalid');
  const frozen = Object.freeze({...policy});
  const key = `common-spend:${frozen.ref}`;
  const read = (): Ledger => {
    const row = storage.kv.get<Ledger>(key);
    if(!row) return {policy:frozen,reservedMicrousd:0,calls:[],cleanup:[]};
    if(JSON.stringify(row.policy)!==JSON.stringify(frozen) || !Array.isArray(row.calls) || !Array.isArray(row.cleanup) ||
       row.cleanup.some(item=>!item.id || !Number.isSafeInteger(item.upperBoundMicrousd) || item.upperBoundMicrousd<0 || !Number.isSafeInteger(item.maxCalls) || item.maxCalls<1 || !Number.isSafeInteger(item.issued) || item.issued<0 || item.issued>item.maxCalls) ||
       new Set(row.cleanup.map(item=>item.id)).size!==row.cleanup.length ||
       row.calls.some(call=>!call.id || !Number.isSafeInteger(call.upperBoundMicrousd) || call.upperBoundMicrousd<0) ||
       new Set(row.calls.map(call=>call.id)).size!==row.calls.length ||
       !Number.isSafeInteger(row.reservedMicrousd) || row.reservedMicrousd<0 ||
       row.reservedMicrousd>frozen.limitMicrousd ||
       row.calls.length+row.cleanup.reduce((sum,item)=>sum+item.maxCalls,0)>frozen.maxCalls ||
       row.calls.reduce((sum,call)=>sum+call.upperBoundMicrousd,0)+row.cleanup.reduce((sum,item)=>sum+item.upperBoundMicrousd,0)!==row.reservedMicrousd) throw Error('common spend ledger conflict');
    return row;
  };
  return Object.freeze({
    reserve(id:string,upperBoundMicrousd:number):void {
      if(!id || id.length>256 || !Number.isSafeInteger(upperBoundMicrousd) || upperBoundMicrousd<0) throw Error('common spend reservation invalid');
      storage.transactionSync(()=>{
        assertCurrent();
        if(now()>=frozen.validUntil) throw Error('common spend policy expired');
        const row=read();
        // A prior intent is uncertainty, not permission to issue the effect again.
        if(row.calls.length+row.cleanup.reduce((sum,item)=>sum+item.maxCalls,0)>=frozen.maxCalls) throw Error('common spend call limit exceeded');
        if(row.calls.some(call=>call.id===id)) throw Error('common spend prior effect requires reconciliation');
        const total=row.reservedMicrousd+upperBoundMicrousd;
        if(!Number.isSafeInteger(total) || total>frozen.limitMicrousd) throw Error('common spend limit exceeded');
        assertTotal?.(upperBoundMicrousd);
        storage.kv.put(key,{...row,reservedMicrousd:total,calls:[...row.calls,{id,upperBoundMicrousd}]});
      });
    },
    reserveCleanup(id:string,upperBoundMicrousd:number,maxCalls:number,commit:()=>void):void {
      if(!id || id.length>256 || !Number.isSafeInteger(upperBoundMicrousd) || upperBoundMicrousd<0 || !Number.isSafeInteger(maxCalls) || maxCalls<1)throw Error('common cleanup reservation invalid');
      storage.transactionSync(()=>{
        assertCurrent();if(now()>=frozen.validUntil)throw Error('common spend policy expired');
        const row=read();
        if(row.cleanup.some(item=>item.id===id))throw Error('common cleanup prior allocation requires reconciliation');
        if(row.calls.length+row.cleanup.reduce((sum,item)=>sum+item.maxCalls,0)+maxCalls>frozen.maxCalls)throw Error('common spend call limit exceeded');
        const total=row.reservedMicrousd+upperBoundMicrousd;
        if(!Number.isSafeInteger(total)||total>frozen.limitMicrousd)throw Error('common spend limit exceeded');
        assertTotal?.(upperBoundMicrousd);
        storage.kv.put(key,{...row,reservedMicrousd:total,cleanup:[...row.cleanup,{id,upperBoundMicrousd,maxCalls,issued:0}]});
        commit();
      });
    },
    consumeCleanup(id:string):void {
      // Only a pre-funded obligation can survive expiry/revocation. No new
      // action grant, money, or call slots are created on this path.
      storage.transactionSync(()=>{
        const row=read(),item=row.cleanup.find(item=>item.id===id);
        if(!item||item.issued>=item.maxCalls)throw Error('common cleanup allowance unavailable');
        storage.kv.put(key,{...row,cleanup:row.cleanup.map(current=>current===item?{...item,issued:item.issued+1}:current)});
      });
    },
    reserved:()=>read().reservedMicrousd,
  });
}

// Quotes are supplied by the registered pricing policy. This module cannot
// turn request text or provider content into a rate or approval.
export type CommonSpendQuote = (kind:'model'|'browser', request:unknown) => number;
export function commonSpendCalls(ledger: ReturnType<typeof commonSpendReservation>,
  quote: CommonSpendQuote,
  options?: Readonly<{countModel?(material:unknown):Promise<number>}>) {
  const modelOrdinals=new Map<string,number>();
  const unreconciledModels=new Set<string>();
  return Object.freeze({
    gateway<T extends {complete(request:any):Promise<any>}>(gateway:T): T {
      return new Proxy(gateway,{get(target,key){if(key!=='complete'){const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}return async(request:Parameters<T['complete']>[0])=>{
        const {runScope:scope,...material}=request;
        if(!scope?.runId||!scope.attempt)throw Error('common model physical identity unavailable');
        scope.admit();
        // Reconstructed wrappers restart at ordinal one. A retained intent
        // denies replay even if request bytes changed; digest-based IDs would
        // incorrectly authorize changed work at the same physical ordinal.
        const physical=JSON.stringify([scope.runId,scope.attempt]);
        if(unreconciledModels.has(physical))throw Error('common model physical history requires reconciliation');
        const ordinal=(modelOrdinals.get(physical)??0)+1;modelOrdinals.set(physical,ordinal);
        const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(physical)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        scope.admit();
        // Exact counted-token witness: the host counter sees the exact request
        // material and returns the vendor/tokenizer input count. Estimates are
        // not admitted; the first reservation pins the physical intent and a
        // reconstructed call conflicts instead of re-pricing or replaying.
        let pricedMaterial:unknown=material;
        if(options?.countModel){
          const counted=await options.countModel(material);
          if(!Number.isSafeInteger(counted)||counted<0||counted>1_050_000)throw Error('common model count witness invalid');
          pricedMaterial={...material,countedInputTokens:counted};
        }
        try{ledger.reserve(`model:${hash}:${ordinal}`,quote('model',pricedMaterial));}
        catch(error){unreconciledModels.add(physical);throw error;}
        return gateway.complete(request);
      };}});
    },
    cleanupBinding<T extends {fetch(...args:any[]):Promise<Response>}>(binding:T,allowanceId:string,providerSessionId:string):T {
      if(!/^[a-zA-Z0-9_-]{1,128}$/.test(providerSessionId)||providerSessionId==='pending')throw Error('common cleanup identity invalid');
      return {fetch:async(...args:Parameters<T['fetch']>)=>{
        const [input,init]=args;
        const request=new Request(input,init),url=new URL(request.url);
        // Pinned SDK 1.3.6: sessions readback and retained-session attach only.
        // A POST acquire, unknown session, alternate host or query is refused.
        const entries=[...url.searchParams];
        const sessions=url.pathname==='/v1/sessions'&&!entries.length;
        const attach=url.pathname===`/v1/devtools/browser/${providerSessionId}`&&entries.length===1&&url.searchParams.get('persistent')==='true'&&request.headers.get('upgrade')?.toLowerCase()==='websocket';
        if(url.origin!=='http://fake.host'||request.method!=='GET'||!sessions&&!attach)throw Error('common cleanup request rejected');
        ledger.consumeCleanup(allowanceId);
        return binding.fetch(...args);
      }} as T;
    },
    binding<T extends {fetch(...args:any[]):Promise<Response>}>(binding:T,operationId:string):T {
      if(!operationId)throw Error('common browser operation identity unavailable');
      let ordinal=0,unreconciled=false;
      return {fetch:async(...args:Parameters<T['fetch']>)=>{
        // Covers acquire, attach, sessions and cleanup requests crossing the
        // provider binding, not page CDP messages already in paid session time.
        if(unreconciled)throw Error('common browser physical history requires reconciliation');
        const next=++ordinal;
        const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(operationId)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
        try{ledger.reserve(`browser:${digest}:${next}`,quote('browser',null));}
        catch(error){unreconciled=true;throw error;}
        return binding.fetch(...args);
      }} as T;
    },
  });
}
