// Verified vendor envelopes, 2026-10-07. Does not grant spend, select an account,
// register a browser or discount uncertain receipts. Highest documented rates
// include cache writes, long context, fast processing and regional processing.
// https://developers.openai.com/api/docs/models/gpt-6-luna
// https://developers.cloudflare.com/browser-run/pricing/
export const COMMON_PRICE_SOURCES=Object.freeze({model:'https://developers.openai.com/api/docs/models/gpt-6-luna',browser:'https://developers.cloudflare.com/browser-run/pricing/',checkedAt:'2026-10-07'});
const integer=(value:number,min:number,max:number)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('price envelope invalid');return BigInt(value);};
const ceiling=(numerator:bigint,denominator:bigint)=>Number((numerator+denominator-1n)/denominator);
// Input tokens must cover the exact wire request, including images, files,
// instructions, prior output and tool schemas. No chars/image heuristic here.
// Callers without verified count can reserve the entire model context window.
export function commonLunaEnvelope(inputTokens:number,outputTokens:number):number{
 const input=integer(inputTokens,0,1_050_000),output=integer(outputTokens,1,128_000);
 // USD/1M: input max cachewrite.125 *long2 *fast2 *regional1.1=.55;
 // output .50 *long1.5 *fast2 *regional1.1=1.65. Microusd/token.
 return ceiling(input*55n+output*165n,100n);
}
export function commonLunaFullContextEnvelope(outputTokens:number):number{return commonLunaEnvelope(1_050_000,outputTokens);}
// Marginal cost of owned allocations, independent of free-tier/headroom and
// competing account usage. Each owned session may add at most one daily peak
// on every billing day touched. Billing days and possible lifetime (including
// unknown acquire/idle) must come from immutable deployment policy, not model.
export function commonCloudflareEnvelope(reservedBrowserMs:number,allocationDayCount:number,billingCycleDays:number):number{
 const duration=integer(reservedBrowserMs,1,Number.MAX_SAFE_INTEGER),days=integer(allocationDayCount,1,366),cycle=integer(billingCycleDays,1,366);
 const roundedHours=(duration+3_600_000n-1n)/3_600_000n;
 // At worst monthly nearest-hour rounding increases by ceil(delta hours).
 return ceiling(roundedHours*90_000n*cycle+days*2_000_000n,cycle);
}
