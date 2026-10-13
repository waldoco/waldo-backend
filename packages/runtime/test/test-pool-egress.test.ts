import {describe,it,expect} from 'vitest';
import {env} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';

const egress=(url:string,init?:RequestInit)=>runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('test-pool-egress')),async()=>{
 const response=await fetch(url,init);
 return {status:response.status,marker:response.headers.get('x-waldo-test-egress'),body:await response.text()};
});

describe('workers test pool egress',()=>{
 it('answers a synthetic-key model call locally with the rejection OpenAI gives it',async()=>{
  const reply=await egress('https://api.openai.com/v1/responses',{method:'POST',headers:{authorization:'Bearer synthetic-key','content-type':'application/json'},body:'{}'});
  expect(reply).toMatchObject({status:401,marker:'blocked'});
  expect(JSON.parse(reply.body)).toMatchObject({error:{type:'invalid_request_error',code:'invalid_api_key'}});
 });
 it('answers a fictional WhatsApp send locally with the rejection Meta gives it',async()=>{
  const reply=await egress('https://graph.facebook.com/v21.0/fictional-phone-id/messages',{method:'POST',headers:{authorization:'Bearer fictional','content-type':'application/json'},body:'{}'});
  expect(reply).toMatchObject({status:401,marker:'blocked'});
  expect(JSON.parse(reply.body)).toMatchObject({error:{type:'OAuthException',code:190}});
 });
 it('refuses any other host without leaving the machine',async()=>{
  expect(await egress('https://example.com/')).toMatchObject({status:502,marker:'blocked',body:'The test pool blocks egress to example.com.'});
 });
});
