import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DevicesControls, IMessageControls, RevealedValue } from './ChannelSetup';
import type { DevicesRecord, IMessageRecord } from './controls-model';

const base = { version: 1 as const, state: 'available' as const, csrf: 'c'.repeat(64), revision: 'a'.repeat(64) };
const bridge = (over: Partial<IMessageRecord['data']['bridges'][number]> = {}): IMessageRecord['data']['bridges'][number] => ({ id: 'imb_' + '0'.repeat(32), kind: 'owner', state: 'pending', subject: null, chat: null, observed: false, host_version: 'host-1', actions: ['imessage.verify', 'imessage.revoke'], ...over });
const imessage = (data: Partial<IMessageRecord['data']> = {}, bridges: IMessageRecord['status']['bridges'] = []): IMessageRecord => ({ ...base, view: 'imessage', data: { enabled: true, address: 'waldo@test.invalid', linked_hint: null, admin: false, phone: null, photon: null, actions: ['imessage.link', 'imessage.pair'], bridges: [], ...data }, status: { bridges } });
const noop = () => {};

describe('iMessage setup', () => {
  it('says plainly when the connector is off and offers nothing', () => {
    const html = renderToStaticMarkup(<IMessageControls record={imessage({ enabled: false, actions: [] })} busy={false} onAction={noop}/>);
    expect(html).toContain('isn’t enabled'); expect(html).not.toContain('<button');
  });
  it('offers what the read lists, keeps the shared number to the operator and escapes senders', () => {
    const html = renderToStaticMarkup(<IMessageControls record={imessage({ bridges: [bridge({ subject: '<img src=x>', chat: 'iMessage;-;<img src=x>', observed: true, actions: ['imessage.verify', 'imessage.activate', 'imessage.revoke'] })] })} busy={false} onAction={noop}/>);
    expect(html).toContain('Get an iMessage link code'); expect(html).toContain('Pair a Mac host'); expect(html).not.toContain('Unlink this number');
    expect(html).toContain('Confirm &lt;img src=x&gt; in iMessage;-;&lt;img src=x&gt;'); expect(html).not.toContain('<img');
    expect(html).toContain('Get a challenge'); expect(html).toContain('Revoke this host');
    expect(html).not.toContain('Shared Waldo number'); expect(html).not.toContain('imessage.pair_shared');
    const operator = renderToStaticMarkup(<IMessageControls record={imessage({ admin: true, linked_hint: '1234', actions: ['imessage.link', 'imessage.unlink', 'imessage.pair', 'imessage.pair_shared'], bridges: [bridge({ kind: 'shared', state: 'active', subject: 'op@test.invalid', chat: 'iMessage;-;op@test.invalid', actions: ['imessage.revoke'] })] }, [{ id: 'imb_' + '0'.repeat(32), online: true, text_ready: true, sending_paused: true }])} busy={false} onAction={noop}/>);
    expect(operator).toContain('Pair the shared number’s host'); expect(operator).toContain('Linked: •••1234'); expect(operator).toContain('Unlink this number');
    expect(operator).toContain('Online · text verified · sending paused');
  });
  it('asks a Photon owner with no Waldo number for their iPhone number, prefilled, and offers no link code yet', () => {
    const html = renderToStaticMarkup(<IMessageControls record={imessage({ address: null, phone: '+15550000001', actions: ['imessage.enroll', 'imessage.pair'] })} busy={false} onAction={noop}/>);
    expect(html).toContain('Get my Waldo number'); expect(html).toContain('value="+15550000001"'); expect(html).not.toContain('Get an iMessage link code');
    const enrolled = renderToStaticMarkup(<IMessageControls record={imessage({ address: '+16285550100', phone: '+15550000001', actions: ['imessage.enroll', 'imessage.link', 'imessage.pair'] })} busy={false} onAction={noop}/>);
    expect(enrolled).toContain('Your Waldo number is <strong>+16285550100</strong>'); expect(enrolled).not.toContain('Get my Waldo number'); expect(enrolled).toContain('Get an iMessage link code');
  });
  it('shows the operator the Photon connection, and nobody else', () => {
    const operator = renderToStaticMarkup(<IMessageControls record={imessage({ admin: true, photon: 'disconnected' })} busy={false} onAction={noop}/>);
    expect(operator).toContain('Connect Photon'); expect(operator).toContain('href="/console/imessage/photon/start"');
    expect(renderToStaticMarkup(<IMessageControls record={imessage({ photon: null })} busy={false} onAction={noop}/>)).not.toContain('Photon');
  });
  it('opens Messages to the number the link code goes to', () => {
    const html = renderToStaticMarkup(<RevealedValue reveal={{ kind: 'link_code', value: 'waldo ABCDEFGHJK', to: '+16285550100' }}/>);
    expect(html).toContain('href="sms:+16285550100&amp;body=waldo%20ABCDEFGHJK"'); expect(html).toContain('Open Messages');
    expect(renderToStaticMarkup(<RevealedValue reveal={{ kind: 'link_code', value: 'waldo ABCDEFGHJK' }}/>)).not.toContain('Open Messages');
  });
  it('disables every control while a request is pending', () => {
    const html = renderToStaticMarkup(<IMessageControls record={imessage({ bridges: [bridge()] })} busy onAction={noop}/>);
    expect(html.match(/<button[^>]*>/g)!.every(button => button.includes('disabled'))).toBe(true);
  });
});

describe('Mac pairing', () => {
  const device: DevicesRecord['data']['devices'][number] = { id: 'dev_fixture', label: '<script>Mac</script>', capabilities: ['machine_state_query'], created_at: '2026-10-16', actions: ['device.revoke', 'device.query'] };
  const devices = (rows: DevicesRecord['data']['devices']): DevicesRecord => ({ ...base, view: 'devices', data: { actions: ['device.pair'], devices: rows, query_kinds: ['session_status', 'attempt_status'], notification_bodies: ['Your Mac is connected.'] }, status: { devices: rows.map(row => ({ id: row.id, online: true, last_seen_at: '2026-10-16 10:00', commands: [{ class: 'machine_state_query', state: 'answered', result_state: 'idle' }] })) } });
  it('escapes labels and offers only the commands a device declared', () => {
    const html = renderToStaticMarkup(<DevicesControls record={devices([device])} busy={false} onAction={noop}/>);
    expect(html).toContain('&lt;script&gt;Mac&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('Ask Mac state'); expect(html).not.toContain('Send this notification');
    expect(html).toContain('Online'); expect(html).toContain('machine_state_query: answered (idle)'); expect(html).toContain('Get pairing code');
  });
  it('shows an empty list as nothing paired', () => {
    expect(renderToStaticMarkup(<DevicesControls record={devices([])} busy={false} onAction={noop}/>)).toContain('No devices yet.');
  });
});

describe('a code shown once', () => {
  it('shows the code as text to copy, never as a link', () => {
    const shown = renderToStaticMarkup(<RevealedValue reveal={{ kind: 'link_code', value: 'waldo ABCDEFGHJK' }}/>);
    expect(shown).toContain('waldo ABCDEFGHJK'); expect(shown).toContain('Copy');
    expect(shown).not.toContain('<a'); expect(shown).not.toContain('href');
  });
});
