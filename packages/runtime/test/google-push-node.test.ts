import {afterEach, describe, expect, it, vi} from 'vitest';
import {googleClient, googleHas} from '../src/connectors/google';
import {googleCalendarPushEvent, googleCalendarPushToken, readGoogleCalendarPushToken, validGooglePushAddress} from '../src/connectors/google-push';
const at = Date.parse('2026-10-10T10:00:00Z');
const app = {clientId:'configured-client',clientSecret:'synthetic-client-secret',redirectUri:'https://waldo.example/oauth/google/callback'};
afterEach(() => vi.restoreAllMocks());
describe('configured Google push wire and admission', () => {
  it('uses actual body read grants while metadata, send, compose, missing scopes remain unavailable', () => {
    for (const scope of ['gmail.readonly','gmail.modify']) expect(googleHas([`https://www.googleapis.com/auth/${scope}`], 'mail')).toBe(true);
    expect(googleHas(['https://mail.google.com/'], 'mail')).toBe(true);
    for (const scopes of [null,undefined,[],['https://www.googleapis.com/auth/gmail.metadata'],['https://www.googleapis.com/auth/gmail.send'],['https://www.googleapis.com/auth/gmail.compose']]) expect(googleHas(scopes, 'mail')).toBe(false);
  });
  it('binds opaque channel token to canonical owner, connection, collection, epoch and operation identity', async () => {
    const witness = {ownerKey:'canonical-app-owner',connectionId:'work-connection',calendarId:'team',channelId:'channel-1',epoch:2};
    const token = await googleCalendarPushToken('existing-synthetic-router-secret', witness);
    expect(await readGoogleCalendarPushToken('existing-synthetic-router-secret', token)).toEqual(witness);
    expect(await readGoogleCalendarPushToken('other-secret', token)).toBeNull();
    expect(await readGoogleCalendarPushToken('existing-synthetic-router-secret', token.slice(0,-2))).toBeNull();
    expect(await readGoogleCalendarPushToken('existing-synthetic-router-secret', token+'.extra')).toBeNull();
    expect(await readGoogleCalendarPushToken('',token)).toBeNull();
  });
  it('accepts only exact registered channel/resource and unexpired numeric provider events', () => {
    const headers = new Headers({'x-goog-channel-id':'channel-1','x-goog-resource-id':'opaque-resource','x-goog-resource-state':'exists','x-goog-message-number':'7'});
    const receipt = {id:'channel-1',resourceId:'opaque-resource',expiration:at+1000};
    expect(googleCalendarPushEvent(headers,receipt,at)).toEqual({eventKey:'calendar-push:channel-1:7',state:'exists'});
    for (const [name,value] of [['x-goog-channel-id','other'],['x-goog-resource-id','foreign'],['x-goog-resource-state','content'],['x-goog-message-number','-1']]) {
      const edited = new Headers(headers); edited.set(name!,value!); expect(googleCalendarPushEvent(edited,receipt,at)).toBeNull();
    }
    expect(googleCalendarPushEvent(headers,receipt,at+1000)).toBeNull();
    for (const address of ['http://receiver.example/push','https://user:pass@receiver.example/push','https://receiver.example/push?token=secret','https://receiver.example/push#fragment']) expect(validGooglePushAddress(address)).toBe(false);
  });
  it('registers the configured Gmail inbox topic and checks the provider renewal receipt', async () => {
    vi.spyOn(Date,'now').mockReturnValue(at);
    const calls: {url:string;init?:RequestInit}[] = [];
    const fetcher = vi.fn(async (input: RequestInfo|URL, init?:RequestInit) => { const url=String(input); calls.push({url,init}); return url.includes('oauth2.googleapis.com') ? Response.json({access_token:'synthetic-access'}) : Response.json({historyId:'1234',expiration:String(at+7*86400000)}); }) as typeof fetch;
    const client = googleClient(app,{refresh_token:'synthetic-refresh'},fetcher);
    expect(await client.watchMail!('projects/waldo-project/topics/owner-inbox')).toEqual({historyId:'1234',expiration:at+7*86400000});
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({topicName:'projects/waldo-project/topics/owner-inbox',labelIds:['INBOX'],labelFilterBehavior:'include'});
    expect(calls[1]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/watch');
    await expect(client.watchMail!('invented-topic')).rejects.toThrow('invalid Gmail watch topic');
  });
  it('creates exact calendar channel and refuses mismatching provider readback', async () => {
    vi.spyOn(Date,'now').mockReturnValue(at);
    const calls: {url:string;init?:RequestInit}[] = [];
    let mismatch=false;
    const fetcher = vi.fn(async(input:RequestInfo|URL,init?:RequestInit) => { const url=String(input); calls.push({url,init}); return url.includes('oauth2.googleapis.com') ? Response.json({access_token:'synthetic-access'}) : Response.json({id:mismatch?'foreign':'channel-1',resourceId:'resource-1',expiration:String(at+86400000)}); }) as typeof fetch;
    const client=googleClient(app,{refresh_token:'synthetic-refresh'},fetcher);
    const channel={id:'channel-1',address:'https://receiver.example/google/calendar',token:'synthetic-existing-key-witness',expiration:at+2*86400000};
    expect(await client.watchCalendarEvents!('team@example.test',channel)).toEqual({id:'channel-1',resourceId:'resource-1',expiration:at+86400000});
    expect(calls[1]!.url).toContain('team%40example.test/events/watch');
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({...channel,type:'web_hook',expiration:String(channel.expiration)});
    mismatch=true; await expect(client.watchCalendarEvents!('team@example.test',channel)).rejects.toThrow('registration outcome unconfirmed');
  });
});

describe('actual connector edge read/write and configured destination fences',()=>{
  it('rejects every read-only grant before write effect dispatch and rejects unconfigured push destinations',async()=>{
    let handler:((request:Request)=>Promise<Response>)|undefined;
    const config:Record<string,string>={SUPABASE_URL:'https://db.example',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',WALDO_ROUTER_HMAC_SECRET:'existing-synthetic-router-secret',GOOGLE_CLIENT_ID:'configured-client',GOOGLE_CLIENT_SECRET:'synthetic-client-secret'};
    const calls:string[]=[];let scopes:string[]=[];
    vi.stubGlobal('Deno',{env:{get:(name:string)=>config[name]},serve:(callback:(request:Request)=>Promise<Response>)=>{handler=callback;}});
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);calls.push(url);if(url.endsWith('/rpc/proxy_access'))return Response.json([{secret:'synthetic-refresh',scopes}]);throw new Error('unexpected provider/effect call');}));
    try{
      await import('../../../supabase/functions/connector-proxy/index.ts');
      const dispatch=async(method:string,args:unknown[]=[])=>{const raw=JSON.stringify({do_name:'canonical-app-owner',op:'call',connection:'work-connection',method,args});const at=Math.floor(Date.now()/1000);const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));const hex=(value:ArrayBuffer)=>[...new Uint8Array(value)].map(byte=>byte.toString(16).padStart(2,'0')).join('');const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(config.WALDO_ROUTER_HMAC_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);const sig=hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${at}.proxy.${hex(digest)}`)));return (await handler!(new Request('https://proxy.example',{method:'POST',headers:{'x-waldo-at':String(at),'x-waldo-sig':sig},body:raw}))).json();};
      for(const [method,scope] of [['sendRaw','gmail.readonly'],['draft','gmail.readonly'],['createEvent','calendar.events.readonly'],['moveEvent','calendar.readonly'],['cancelEvent','calendar.readonly'],['createTask','tasks.readonly'],['patchTask','tasks.readonly']]){
        scopes=[`https://www.googleapis.com/auth/${scope}`];expect(await dispatch(method!)).toMatchObject({error:{status:403,message:'insufficient scopes'}});
      }
      scopes=['https://www.googleapis.com/auth/gmail.readonly'];expect(await dispatch('watchMail',['projects/waldo-project/topics/owner-inbox'])).toMatchObject({error:{status:503,message:'source_push_unavailable'}});
      config.WALDO_GOOGLE_GMAIL_PUBSUB_TOPIC='projects/waldo-project/topics/owner-inbox';expect(await dispatch('watchMail',['projects/foreign-project/topics/foreign-inbox'])).toMatchObject({error:{status:503,message:'source_push_unavailable'}});
      scopes=['https://www.googleapis.com/auth/calendar.events.readonly'];config.WALDO_GOOGLE_CALENDAR_PUSH_URL='https://receiver.example/google/calendar';
      const witness={ownerKey:'foreign-owner',connectionId:'work-connection',calendarId:'team',channelId:'channel-1',epoch:2};const token=await googleCalendarPushToken(config.WALDO_ROUTER_HMAC_SECRET!,witness);
      expect(await dispatch('watchCalendarEvents',['team',{id:'channel-1',address:config.WALDO_GOOGLE_CALENDAR_PUSH_URL,token,expiration:Date.now()+86400000}])).toMatchObject({error:{status:403,message:'source_push_rejected'}});
      expect(calls.every(url=>url.endsWith('/rpc/proxy_access'))).toBe(true);
      let revoked=false,providerRegistrations=0;scopes=['https://www.googleapis.com/auth/gmail.readonly'];
      vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);if(url.endsWith('/rpc/proxy_access'))return Response.json(revoked?[]:[{secret:'synthetic-refresh',scopes}]);if(url.includes('oauth2.googleapis.com')){revoked=true;return Response.json({access_token:'synthetic-access'});}if(url.endsWith('/watch'))providerRegistrations++;throw new Error('unexpected provider registration');}));
      expect(await dispatch('watchMail',[config.WALDO_GOOGLE_GMAIL_PUBSUB_TOPIC])).toMatchObject({error:{status:403,message:'source_push_admission_changed'}});expect(providerRegistrations).toBe(0);
      for(const scope of ['calendar.events.readonly','calendar.readonly','calendar']) expect(googleHas([`https://www.googleapis.com/auth/${scope}`],'calendar')).toBe(true);
      expect(googleHas(['https://www.googleapis.com/auth/tasks.readonly'],'tasks')).toBe(true);expect(googleHas(null,'calendar')).toBe(false);expect(googleHas(null,'tasks')).toBe(false);
    }finally{vi.unstubAllGlobals();}
  });
});
