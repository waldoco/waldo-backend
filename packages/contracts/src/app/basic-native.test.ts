import { expect, it } from 'vitest';
import { appCoreRoutesV1, appSessionV1Schema, appSendRequestV1Schema, appMessageReceiptV1Schema } from './core';
import { appControlActionV1Schema, appControlQueryV1Schema } from './controls';
it('requires full scoped session hashes and fixed absolute expiry',()=>{
  const session={state:'active',session_ref:`sess_${'a'.repeat(64)}`,account_ref:`acct_${'b'.repeat(64)}`,surface:'app',absolute_expires_at:Date.now()+1000};
  expect(appSessionV1Schema.safeParse(session).success).toBe(true);
  expect(appSessionV1Schema.safeParse({...session,session_ref:'legacy-short-ref'}).success).toBe(false);
  expect(appSessionV1Schema.safeParse({...session,absolute_expires_at:undefined}).success).toBe(false);
});
it('text bounds match durable receipt route and reject client authority',()=>{
  const send={client_message_id:'client-message-0001',text:'x'.repeat(4000)};
  expect(appSendRequestV1Schema.safeParse(send).success).toBe(true);
  expect(appSendRequestV1Schema.safeParse({...send,text:'x'.repeat(4001)}).success).toBe(false);
  expect(appSendRequestV1Schema.safeParse({...send,owner:'foreign'}).success).toBe(false);
  expect(appCoreRoutesV1.some(route=>route.path==='/app/v1/chat/main/messages/{client_message_id}')).toBe(true);
  expect(appMessageReceiptV1Schema.parse({accepted:true,message_id:'app-123',state:'interrupted',closed_reason:'interrupted',effects_unconfirmed:true}).effects_unconfirmed).toBe(true);
});
it('exposes basic views and bounded settings actions',()=>{
  for(const view of ['day','connections','activity'])expect(appControlQueryV1Schema.safeParse({view}).success).toBe(true);
  expect(appControlQueryV1Schema.safeParse({view:'waiting'}).success).toBe(false);
  const action={view:'day',action:'timezone.set',value:'UTC',revision:'a'.repeat(64),request_id:'request-0001'};
  expect(appControlActionV1Schema.safeParse(action).success).toBe(true);
  expect(appControlActionV1Schema.safeParse({...action,action:'approval.approve'}).success).toBe(false);
});
