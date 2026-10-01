import { expect, it } from 'vitest';
import { googleHandlers } from '../src/tools/live/google';
const range={from:'2026-10-01T00:00:00+05:30',to:'2026-10-02T00:00:00+05:30'};
it('empty Gmail AND query offers bounded recovery without silently changing the request',async()=>{
 const queries:string[]=[];const handlers=googleHandlers({client:async()=>({searchMail:async(q:string)=>{queries.push(q);return [];}})} as never,{} as never,{timezone:'Asia/Kolkata',now:()=>new Date('2026-10-01T04:52:00Z')});
 const result=await handlers.find(h=>h.name==='search_communication')!.handle({query:'Waldo backend pull request',date_range:range,limit:20} as never);
 expect(queries).toHaveLength(1);expect(queries[0]).toContain('Waldo backend pull request');expect(queries[0]).toContain('after:');
 expect(result).toMatchObject({ok:true,data:{messages:[],recovery:{status:'empty_query_not_absence',attempt_budget:2,preserve_date_range:true,query_semantics:'unquoted_terms_are_conjunctive',next_step:'Search fewer distinctive terms or a known sender/repository. Keep the same account and date range. Read returned subjects/snippets to check relevance.'}}});
});
it('operator and quoted searches stay exact, not guessed or rewritten',async()=>{
 const queries:string[]=[];const handlers=googleHandlers({client:async()=>({searchMail:async(q:string)=>{queries.push(q);return [];}})} as never,{} as never,{timezone:'Asia/Kolkata',now:()=>new Date('2026-10-01T04:52:00Z')});
 await handlers.find(h=>h.name==='search_communication')!.handle({query:'from:github.com "waldoco/waldo-backend"',date_range:range,limit:3} as never);expect(queries[0]).toContain('from:github.com "waldoco/waldo-backend"');expect(queries).toHaveLength(1);
});
