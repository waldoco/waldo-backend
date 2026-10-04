import { expect, it } from 'vitest';
import { redeemBody, heartbeatFrame, connectDeclaration } from '../src/devices/wire';
const redeem = { code: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', device_pubkey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', label: 'Test Mac', declared_capabilities: ['machine_state_query', 'notify_local'], contract_version: '0.2.3' };
it('admits only the closed redeem shape with canonical capability order', () => {
  expect(redeemBody(redeem)).toEqual(redeem);
  for (const bad of [{ ...redeem, device_id: 'dev_1' }, { ...redeem, label: null }, { ...redeem, declared_capabilities: ['notify_local', 'machine_state_query'] }, { ...redeem, declared_capabilities: [] }, { ...redeem, contract_version: '0.2.2' }]) expect(redeemBody(bad)).toBeNull();
});
it('requires exact connect query spelling and order', () => {
  expect(connectDeclaration('/devices/connect?contract_version=0.2.3&declared_capabilities=machine_state_query,notify_local')).toEqual(['machine_state_query', 'notify_local']);
  for (const path of ['/devices/connect', '/devices/connect?contract_version=0.2.3&declared_capabilities=machine_state_query%2Cnotify_local', '/devices/connect?declared_capabilities=machine_state_query&contract_version=0.2.3', '/devices/connect?contract_version=0.2.3&declared_capabilities=machine_state_query&extra=1']) expect(connectDeclaration(path)).toBeNull();
});
it('rejects widened or binding-free heartbeat shapes', () => {
  const frame = { type: 'heartbeat', contract_version: '0.2.3', message_id: '01ARZ3NDEKTSV4RRFFQ69G5FAZ', owner_id: 'owner_1', device_id: 'dev_1', timestamp: 1790200800, nonce: 'AAECAwQFBgcICQoLDA0ODw', signature: '1DzrSOApCr5iU_sTuJFozlndCY-A1EhY0XVtYGf07nP_OoW_Q8bI1a9OakAvlfJBBfBQb1NDevyyH4Q3tbWzDA', payload: { declared_capabilities: ['machine_state_query'], outbox_depth: 0 } };
  expect(heartbeatFrame(frame)).toEqual(frame);
  expect(heartbeatFrame({ ...frame, extra: 1 })).toBeNull();
  expect(heartbeatFrame({ ...frame, payload: { ...frame.payload, outbox_depth: -1 } })).toBeNull();
});
