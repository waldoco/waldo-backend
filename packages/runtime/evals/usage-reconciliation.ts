// Response capture/trace consistency, never independent invoice proof.
// Legacy billed rows are diagnostic input only; native callers use actual Responses
// token receipts and a separately labelled, versioned estimate.
export type UsageLine = Readonly<{
  response_id:string;model:string;input_tokens:number;output_tokens:number;cached_tokens:number;
  billed_usd?:number;
}>;
export type UsageReconciliation=Readonly<{
 status:'consistent_unverified'|'harness_error'; errors:readonly string[]; total_usd:number|null;
 billing_status?:'unreconciled';
}>;
const validLine=(line:UsageLine):boolean=>Boolean(line.response_id?.trim()&&line.model?.trim())&&
 [line.input_tokens,line.output_tokens,line.cached_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)&&
 line.cached_tokens<=line.input_tokens&&
 (line.billed_usd===undefined||(Number.isFinite(line.billed_usd)&&line.billed_usd>=0));
const sameUsage=(a:UsageLine,b:UsageLine):boolean=>a.response_id===b.response_id&&a.model===b.model&&
 a.input_tokens===b.input_tokens&&a.output_tokens===b.output_tokens&&a.cached_tokens===b.cached_tokens;
export const parseResponseUsage=(value:unknown):UsageLine=>{
 const r=value as {id?:unknown;model?:unknown;usage?:{input_tokens?:unknown;output_tokens?:unknown;input_tokens_details?:{cached_tokens?:unknown}}};
 const line:UsageLine={response_id:typeof r?.id==='string'?r.id:'',model:typeof r?.model==='string'?r.model:'',
 input_tokens:r?.usage?.input_tokens as number,output_tokens:r?.usage?.output_tokens as number,
 cached_tokens:(r?.usage?.input_tokens_details?.cached_tokens??0) as number};
 if(!validLine(line))throw new Error('invalid Responses usage receipt');
 return Object.freeze(line);
};
export type UsageTariff=Readonly<{version:string;model:string;input_per_million:number;cached_per_million:number;output_per_million:number}>;
export const estimateTrialUsage=(rows:readonly UsageLine[],tariff:UsageTariff):Readonly<{kind:'estimate_not_bill';tariff_version:string;total_usd:number}>=>{
 if(!tariff.version.trim()||!tariff.model.trim()||![tariff.input_per_million,tariff.cached_per_million,tariff.output_per_million].every(n=>Number.isFinite(n)&&n>=0)||
 !rows.length||rows.some(r=>!validLine(r)||r.model!==tariff.model)||new Set(rows.map(r=>r.response_id)).size!==rows.length)throw new Error('invalid versioned usage estimate inputs');
 const total=rows.reduce((sum,r)=>sum+(r.input_tokens-r.cached_tokens)*tariff.input_per_million/1e6+r.cached_tokens*tariff.cached_per_million/1e6+r.output_tokens*tariff.output_per_million/1e6,0);
 if(!Number.isFinite(total))throw new Error('invalid usage estimate total');
 return {kind:'estimate_not_bill',tariff_version:tariff.version,total_usd:total};
};
export const reconcileTrialUsage=(runner:readonly UsageLine[],responseCapture:readonly UsageLine[],assertedCostUsd:number|null):UsageReconciliation=>{
 const errors:string[]=[];
 if(!runner.length||!responseCapture.length)errors.push('missing model usage');
 if(runner.some(r=>!validLine(r))||responseCapture.some(r=>!validLine(r)))errors.push('invalid usage line');
 if(new Set(runner.map(r=>r.response_id)).size!==runner.length||new Set(responseCapture.map(r=>r.response_id)).size!==responseCapture.length)errors.push('duplicate response id');
 if(runner.length!==responseCapture.length||runner.some(r=>{const p=responseCapture.find(p=>p.response_id===r.response_id);return !p||!sameUsage(r,p);}))errors.push('provider response usage mismatch');
 const legacy=[...runner,...responseCapture].some(r=>r.billed_usd!==undefined);
 if(!legacy){
  if(assertedCostUsd!==null)errors.push('unreconciled billing must not carry asserted cost');
  return {status:errors.length?'harness_error':'consistent_unverified',errors,total_usd:null,billing_status:'unreconciled'};
 }
 // Kept for historic packet diagnostics, explicitly not the native run rail.
 if([...runner,...responseCapture].some(r=>r.billed_usd===undefined)||runner.some(r=>{const p=responseCapture.find(p=>p.response_id===r.response_id);return !p||p.billed_usd===undefined||r.billed_usd===undefined||Math.abs(p.billed_usd-r.billed_usd)>1e-8;}))errors.push('provider response usage mismatch');
 const cost=responseCapture.reduce((sum,r)=>sum+(r.billed_usd??0),0);
 if(assertedCostUsd===null||!Number.isFinite(assertedCostUsd)||assertedCostUsd<0||!Number.isFinite(cost)||Math.abs(assertedCostUsd-cost)>1e-8)errors.push('provider cost mismatch');
 return {status:errors.length?'harness_error':'consistent_unverified',errors,total_usd:errors.length?null:cost};
};
