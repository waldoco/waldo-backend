import { expect, it } from 'vitest';
import { smokeModelFetch, type SmokeRequestReceipt } from '../scenarios/smoke-model-fetch';
const url = 'https://api.openai.com/v1/responses';
it('uses supported manual redirect mode and records actual response model/usage', async () => {
 const rows: SmokeRequestReceipt[]=[]; const denied:string[]=[];
 const network = (async (_input, init) => { expect(init?.redirect).toBe('manual'); return Response.json({id:'resp_fixture',model:'actual-fixture-model',usage:{input_tokens:3}}); }) as typeof fetch;
 expect((await smokeModelFetch(network,rows,denied)(url,{method:'POST'})).status).toBe(200);
 expect(rows[0]).toMatchObject({status:200,response_id:'resp_fixture',model:'actual-fixture-model',usage:{input_tokens:3},failure:null});
});
it.each([301,302,303,307,308])('rejects redirect%s without following or recording Location', async status => {
 let calls=0;const rows:SmokeRequestReceipt[]=[];
 const boundary=smokeModelFetch((async()=>{calls++;return new Response(null,{status,headers:{location:'https://other.invalid/?private=fixture'}});}) as typeof fetch,rows,[]);
 await expect(boundary(url,{method:'POST'})).rejects.toThrow('redirect rejected');
 expect(calls).toBe(1);expect(rows[0]).toMatchObject({status,failure:'redirect'});expect(JSON.stringify(rows)).not.toContain('private');
});
it('counts failed attempts towards the ceiling and drops raw exception text', async()=>{
 const rows:SmokeRequestReceipt[]=[];let calls=0;
 const boundary=smokeModelFetch((async()=>{calls++;throw new Error('synthetic-sensitive-value');}) as typeof fetch,rows,[]);
 for(let n=0;n<8;n++) await expect(boundary(url,{method:'POST'})).rejects.toThrow('smoke model transport failed');
 await expect(boundary(url,{method:'POST'})).rejects.toThrow('cap reached');expect(calls).toBe(8);expect(rows).toHaveLength(8);expect(JSON.stringify(rows)).not.toContain('sensitive');
});
it('rejects wrong URL and method before network and records no query',async()=>{
 let calls=0;const denied:string[]=[];const boundary=smokeModelFetch((async()=>{calls++;return Response.json({});}) as typeof fetch,[],denied);
 await expect(boundary(url,{method:'GET'})).rejects.toThrow('destination');
 await expect(boundary('https://other.invalid/?private=fixture',{method:'POST'})).rejects.toThrow('destination');expect(calls).toBe(0);expect(JSON.stringify(denied)).not.toContain('private');
});
it('captures HTTP error status and malformed response classification',async()=>{
 const rows:SmokeRequestReceipt[]=[];
 const boundary=smokeModelFetch((async()=>new Response('not json',{status:401})) as typeof fetch,rows,[]);
 expect((await boundary(url,{method:'POST'})).status).toBe(401);expect(rows[0]).toMatchObject({status:401,failure:'response_json'});
});
