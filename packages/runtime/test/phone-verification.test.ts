import { expect, it, vi } from 'vitest';
import { twilioPhoneVerification } from '../src/identity/phone-verification';
const service = `VA${'a'.repeat(32)}`;
const sid = `VE${'b'.repeat(32)}`;
const phone = '+919876543210';
const credentials = { user: `AC${'c'.repeat(32)}`, secret: 'synthetic-provider-token', service };
it('starts a provider-owned code with SMS only and without a local code', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({service_sid:service,sid,to:phone,channel:'sms',status:'pending'}));
  const provider = twilioPhoneVerification(credentials, fetcher)!;
  expect(await provider.start(phone)).toEqual({kind:'pending',reference:{service,sid,phone}});
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://verify.twilio.com/v2/Services/${service}/Verifications`);
  const body = new URLSearchParams(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body));
  expect([...body.entries()]).toEqual([['To',phone],['Channel','sms']]);
});
it('checks only the stored verification reference and accepts status approved', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({service_sid:service,sid,to:phone,channel:'sms',status:'approved',valid:false}));
  expect(await twilioPhoneVerification(credentials,fetcher)!.check({service,sid,phone},'123456')).toEqual({kind:'approved',reference:{service,sid,phone}});
  expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body)).get('VerificationSid')).toBe(sid);
  expect(String(fetcher.mock.calls[0]![1]!.body)).not.toContain('To=');
});
it.each([{to:'+14155550100'},{sid:`VE${'d'.repeat(32)}`},{service_sid:`VA${'d'.repeat(32)}`},{status:'pending',valid:true}])('does not turn a foreign or pending response into proof: %j', async override => {
  const fetcher = vi.fn(async () => Response.json({service_sid:service,sid,to:phone,channel:'sms',status:'approved',...override}));
  const result = await twilioPhoneVerification(credentials,fetcher)!.check({service,sid,phone},'123456');
  expect(result.kind).toBe(override.status === 'pending' ? 'pending' : 'unknown');
});
it.each([[429,'throttled'],[404,'expired'],[500,'unknown']])('normalizes HTTP %s without reflecting its body', async (status,kind) => {
  const fetcher = vi.fn(async () => new Response('sensitive provider details',{status:Number(status)}));
  expect(await twilioPhoneVerification(credentials,fetcher)!.check({service,sid,phone},'123456')).toEqual({kind});
});
it('rejects missing credentials and malformed recipient/code without transport', async () => {
  const fetcher=vi.fn();
  expect(twilioPhoneVerification(null,fetcher)).toBeNull();
  expect(twilioPhoneVerification({...credentials,service:'https://attacker.invalid'},fetcher)).toBeNull();
  const provider=twilioPhoneVerification(credentials,fetcher)!;
  expect(await provider.start('9876543210')).toEqual({kind:'unknown'});
  expect(await provider.check({service,sid,phone},'bad')).toEqual({kind:'unknown'});
  expect(fetcher).not.toHaveBeenCalled();
});
it('fences stalled decoder/fetch and malformed JSON with an unknown result', async () => {
  vi.useFakeTimers();
  try {
    for(const mode of ['fetch','decoder','malformed']) {
      const fetcher=vi.fn(async () => mode==='fetch' ? new Promise<Response>(()=>{}) : mode==='decoder'
        ? {ok:true,status:200,json:()=>new Promise(()=>{})} as Response : new Response('{',{status:200}));
      const pending=twilioPhoneVerification(credentials,fetcher)!.start(phone);
      await vi.advanceTimersByTimeAsync(10000);
      expect(await pending).toEqual({kind:'unknown'});
    }
  } finally {vi.useRealTimers();}
});
it('never reads a send as approved: only a pending verification counts as sent', async () => {
  const fetcher = vi.fn(async () => Response.json({service_sid:service,sid,to:phone,channel:'sms',status:'approved'}));
  expect(await twilioPhoneVerification(credentials,fetcher)!.start(phone)).toEqual({kind:'unknown'});
});
it.each([[400, 60200], [401, 20003], [403, 20403], [404, 20404]])('a send Twilio refuses with HTTP %s created nothing, and keeps only its numeric code', async (status, code) => {
  const fetcher = vi.fn(async () => Response.json({ code, message: `Invalid parameter To: ${phone}`, more_info: 'https://www.twilio.com/docs/errors', status }, { status }));
  expect(await twilioPhoneVerification(credentials, fetcher)!.start(phone)).toEqual({ kind: 'refused', status, code });
});
it('a refusal without a numeric code keeps the status alone', async () => {
  for (const body of ['not json', JSON.stringify({ code: '20003' }), JSON.stringify({ code: 1.5 })]) {
    const fetcher = vi.fn(async () => new Response(body, { status: 401 }));
    expect(await twilioPhoneVerification(credentials, fetcher)!.start(phone)).toEqual({ kind: 'refused', status: 401, code: null });
  }
});
it('a check Twilio refuses checked nothing; a missing verification still reads as expired', async () => {
  const refused = vi.fn(async () => Response.json({ code: 20003 }, { status: 401 }));
  expect(await twilioPhoneVerification(credentials, refused)!.check({ service, sid, phone }, '123456')).toEqual({ kind: 'refused', status: 401, code: 20003 });
  const missing = vi.fn(async () => Response.json({ code: 20404 }, { status: 404 }));
  expect(await twilioPhoneVerification(credentials, missing)!.check({ service, sid, phone }, '123456')).toEqual({ kind: 'expired' });
});
it('authenticates with an API key, restricted or standard, as well as the account token', async () => {
  const key = `SK${'e'.repeat(32)}`;
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({service_sid:service,sid,to:phone,channel:'sms',status:'pending'}));
  await twilioPhoneVerification({ user: key, secret: 'synthetic-key-secret', service }, fetcher)!.start(phone);
  expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('authorization')).toBe(`Basic ${btoa(`${key}:synthetic-key-secret`)}`);
  for (const user of ['SKshort', `XX${'e'.repeat(32)}`, `sk${'e'.repeat(32)}`]) expect(twilioPhoneVerification({ user, secret: 'synthetic-key-secret', service }, fetcher)).toBeNull();
});
