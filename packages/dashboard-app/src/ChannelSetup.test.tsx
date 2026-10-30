import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DevicesControls, IMessageControls, PhoneControls, RevealedValue } from './ChannelSetup';
import type { DevicesRecord, IMessageRecord, PhoneRecord } from './controls-model';

const base = { version: 1 as const, state: 'available' as const, csrf: 'c'.repeat(64), revision: 'a'.repeat(64) };
const bridge = (over: Partial<IMessageRecord['data']['bridges'][number]> = {}): IMessageRecord['data']['bridges'][number] => ({ id: 'imb_' + '0'.repeat(32), kind: 'owner', state: 'pending', subject: null, chat: null, observed: false, host_version: 'host-1', actions: ['imessage.verify', 'imessage.revoke'], ...over });
const imessage = (data: Partial<IMessageRecord['data']> = {}, bridges: IMessageRecord['status']['bridges'] = []): IMessageRecord => ({ ...base, view: 'imessage', data: { enabled: true, address: 'waldo@test.invalid', linked_hint: null, admin: false, phone: null, photon: null, phone_on_file: null, actions: ['imessage.link', 'imessage.pair'], bridges: [], ...data }, status: { bridges } });
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
  it('says a number typed at sign-up is not verified yet and how to verify it, until a code arrives from it', () => {
    const unverified = renderToStaticMarkup(<IMessageControls record={imessage({ address: '+16285550100', phone_on_file: { phone: '+15550000001', verified: false } })} busy={false} onAction={noop}/>);
    expect(unverified).toContain('Your number on file, <strong>+15550000001</strong>, is not verified yet.');
    expect(unverified).toContain('text your link code to Waldo from that number');
    const verified = renderToStaticMarkup(<IMessageControls record={imessage({ phone_on_file: { phone: '+15550000001', verified: true } })} busy={false} onAction={noop}/>);
    expect(verified).toContain('Your number on file, <strong>+15550000001</strong>, is verified.');
    expect(verified).not.toContain('not verified yet');
    expect(renderToStaticMarkup(<IMessageControls record={imessage()} busy={false} onAction={noop}/>)).not.toContain('number on file');
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
  it('opens WhatsApp to the Waldo number for a WhatsApp link code, never Messages', () => {
    const html = renderToStaticMarkup(<RevealedValue reveal={{ kind: 'link_code', value: 'waldo ABCDEFGHJK', to: '+919226067544', app: 'whatsapp' }}/>);
    expect(html).toContain('href="https://wa.me/919226067544?text=waldo%20ABCDEFGHJK"'); expect(html).toContain('Open WhatsApp');
    expect(html).not.toContain('sms:'); expect(html).not.toContain('iPhone');
    const bare = renderToStaticMarkup(<RevealedValue reveal={{ kind: 'link_code', value: 'waldo ABCDEFGHJK', app: 'whatsapp' }}/>);
    expect(bare).not.toContain('wa.me'); expect(bare).not.toContain('Open Messages'); expect(bare).toContain('WhatsApp');
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

describe('your phone', () => {
  const phone = (data: Partial<PhoneRecord['data']> = {}): PhoneRecord => ({ ...base, view: 'phone', data: { phone: '+919800000001', verified: false, sms: true, challenge: null, actions: ['phone.sms_send'], ...data } });
  const pending = { state: 'pending' as const, expires_at: 1_800_000_600, retry_at: null, checks_left: 5 };
  it('says an unverified number is sent nothing, and offers the link code and a texted code', () => {
    const html = renderToStaticMarkup(<PhoneControls record={phone()} busy={false} onAction={noop}/>);
    expect(html).toContain('<strong>+919800000001</strong>, is not verified yet. Waldo sends nothing to it until it is.');
    expect(html).toContain('href="#/connections/imessage"'); expect(html).toContain('Twilio sends the text');
    expect(html).toContain('Text me a code'); expect(html).not.toContain('Code from the text');
  });
  it('offers only the link code with texting off, and nothing for a verified number or none on file', () => {
    const off = renderToStaticMarkup(<PhoneControls record={phone({ sms: false, actions: [] })} busy={false} onAction={noop}/>);
    expect(off).toContain('text your link code'); expect(off).not.toContain('Twilio'); expect(off).not.toContain('<button');
    const verified = renderToStaticMarkup(<PhoneControls record={phone({ verified: true, actions: [] })} busy={false} onAction={noop}/>);
    expect(verified).toContain('is verified.'); expect(verified).not.toContain('<button');
    expect(renderToStaticMarkup(<PhoneControls record={phone({ phone: null, actions: [] })} busy={false} onAction={noop}/>)).toContain('There is no phone number on file.');
  });
  it('asks for the code while one waits, and says when another may be asked for', () => {
    const waiting = renderToStaticMarkup(<PhoneControls record={phone({ challenge: { ...pending, retry_at: 1_800_000_060 }, actions: ['phone.sms_check'] })} busy={false} onAction={noop}/>);
    expect(waiting).toContain('Code from the text'); expect(waiting).toContain('one-time-code');
    expect(waiting).toContain('You can ask for another code after'); expect(waiting).not.toContain('Text the code again');
    const resend = renderToStaticMarkup(<PhoneControls record={phone({ challenge: pending, actions: ['phone.sms_send', 'phone.sms_check'] })} busy={false} onAction={noop}/>);
    expect(resend).toContain('Text the code again'); expect(resend).not.toContain('You can ask for another code after');
    expect(renderToStaticMarkup(<PhoneControls record={phone({ challenge: { ...pending, state: 'unknown', retry_at: 1_800_003_600 }, actions: [] })} busy={false} onAction={noop}/>)).toContain('Twilio did not confirm the last text.');
    // A code that ran out and a text Twilio turned down both leave no code waiting.
    expect(renderToStaticMarkup(<PhoneControls record={phone({ challenge: { ...pending, state: 'expired', retry_at: 1_800_000_060 }, actions: [] })} busy={false} onAction={noop}/>)).toContain('No code is waiting for this number.');
  });
});
