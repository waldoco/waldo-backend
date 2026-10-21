import { expect, it } from 'vitest';
import { iMessageEventSchema } from '@waldo/contracts';
import { syntheticIMessageEvents } from '../../contracts/src/channels/imessage-v1-fixtures';
import { fixture, digest } from './connector-fixtures';
import { classifyInboundEvent, correlateReceipt } from '../src/connector/receipts';
it('receipt correlation is account scoped candidate evidence; no result is upgraded', async () => { const f = fixture(); const c = f.command(), r = f.signed(c), d = f.mailbox.enqueue(r.body, r.headers), pull = f.pullRequest(); await f.mailbox.pull(pull.body, pull.headers, { waitMs: 0 }); const post = f.signed({ version: 1, bridgeId: c.binding.bridgeId, accountId: c.binding.accountId, deliveryId: d.deliveryId, commandId: c.commandId, commandDigest: digest(r.body), result: { version: 1, commandId: c.commandId, target: c.target, state: 'local_recorded', messageGuid: 'synthetic-guid', evidence: { kind: 'local_database', reference: 'synthetic-row' } } }); f.mailbox.postResult(post.body, post.headers); const { text, attachments, kind, ...base } = syntheticIMessageEvents.text; const event = iMessageEventSchema.parse({ ...base, kind: 'receipt', state: 'read', target: { ...c.target, messageGuid: 'synthetic-guid' } }); if (event.kind !== 'receipt')
    throw Error('synthetic-type'); expect(classifyInboundEvent(event)).toBe('receipt'); expect(correlateReceipt(f.mailboxStore, event)).toEqual({ commandId: c.commandId }); expect(correlateReceipt(f.mailboxStore, { ...event, accountId: 'synthetic-other', target: { ...event.target, accountId: 'synthetic-other' } })).toEqual({ commandId: null }); expect(f.mailbox.delivery(d.deliveryId)!.result!.state).toBe('local_recorded'); expect(classifyInboundEvent(iMessageEventSchema.parse(syntheticIMessageEvents.text))).toBe('turn'); expect(classifyInboundEvent(iMessageEventSchema.parse(syntheticIMessageEvents.group))).toBe('ignorable'); });

import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
it('G1 new connector sources and fixtures contain only synthetic keys and no address literals',()=>{
 const root=resolve(import.meta.dirname,'..');
 const paths=[...readdirSync(resolve(root,'src/connector')).map(n=>resolve(root,'src/connector',n)),...readdirSync(resolve(root,'test')).filter(n=>n.startsWith('connector-')).map(n=>resolve(root,'test',n)),resolve(root,'../runtime/src/channels/imessage/relay-ingest.ts')];
 for(const path of paths){const source=readFileSync(path,'utf8');expect(source).not.toMatch(/https?:\/\//);expect(source).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);expect(source).not.toMatch(/['"]\+?\d{10,15}['"]/);for(const match of source.matchAll(/key:\s*['"]([^'"]+)['"]/g))expect(match[1]).toMatch(/^synthetic-/);}
});
