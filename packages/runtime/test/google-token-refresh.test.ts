import {expect,it,vi} from 'vitest';
import {googleAccessToken,googleClient} from '../src/connectors/google';
const app={clientId:'fixture-client',clientSecret:'fixture-secret',redirectUri:''};
it.each(['native','bearer'])('%s local refresh reports only invalid grants to health and recovers without changing credentials',async lane=>{
 for(const c of [{status:400,error:'invalid_grant',kind:'auth',expected:401},{status:429,error:'invalid_grant',kind:'transient',expected:429},{status:503,error:'temporarily_unavailable',kind:'transient',expected:503},{status:401,error:'invalid_client',kind:'configuration',expected:502},{status:0,error:'network',kind:'transient',expected:502},{status:0,error:'timeout',kind:'transient',expected:502},{status:200,error:null,kind:'protocol',expected:502}]){
  const health=vi.fn();const credentials:string[]=[];let failing=true;
  const fetcher:typeof fetch=async(input,init)=>{
   if(String(input)==='https://oauth2.googleapis.com/token'){
    credentials.push(new URLSearchParams(String(init?.body)).get('refresh_token')!);
    if(failing){if(!c.status)throw new DOMException('PRIVATE_TRANSPORT',c.error==='timeout'?'TimeoutError':'NetworkError');return c.error===null?new Response('PRIVATE_HTML'):Response.json({error:c.error,error_description:'PRIVATE_DESCRIPTION'},{status:c.status});}
    return Response.json({access_token:'fixture-access'});
   }
   return Response.json({items:[]});
  };
  const client=googleClient(app,{refresh_token:'pinned-refresh'},fetcher,health);
  const call=()=>lane==='native'?client.events('2026-10-01T00:00:00Z','2026-10-02T00:00:00Z',1,false):googleAccessToken(app,{refresh_token:'pinned-refresh'},fetcher,health);
  await expect(call()).rejects.toMatchObject({name:'GoogleTokenError',kind:c.kind,status:c.expected});
  expect(health.mock.calls).toEqual(c.kind==='auth'?[['google token auth failure']]:[]);
  failing=false;await call();expect(health.mock.calls.at(-1)).toEqual(['']);expect(credentials).toEqual(['pinned-refresh','pinned-refresh']);
 }
});
