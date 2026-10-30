import { useRef, useState } from 'react';
import type { ActionReveal, ControlAction, ControlFields, DevicesRecord, IMessageRecord, PhoneRecord } from './controls-model';

type Actions = { busy: boolean; onAction: (action: ControlAction, fields?: ControlFields) => void };

const REVEAL_LABEL: Record<ActionReveal['kind'], string> = { link_code: 'Text this from your iPhone', host_code: 'Mac host code', challenge: 'Challenge text', pairing_code: 'Kennel pairing code' };
// The value is shown once. If the clipboard is refused, the whole value is selected so one keystroke copies it.
/** sms: link that opens Messages to `to` with the text filled in (the iPhone's one-tap send). */
const smsLink = (to: string, body: string) => `sms:${encodeURIComponent(to).replace(/%40/g, '@').replace(/%2B/g, '+')}&body=${encodeURIComponent(body)}`;
/** WhatsApp's click-to-chat link to `to` (+E.164) with the text filled in. */
const waLink = (to: string, body: string) => `https://wa.me/${to.slice(1)}?text=${encodeURIComponent(body)}`;
export function RevealedValue({ reveal }: { reveal: ActionReveal }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'selected'>('idle');
  const value = useRef<HTMLParagraphElement>(null);
  const onCopy = async () => {
    try { await navigator.clipboard.writeText(reveal.value); setCopy('copied'); }
    catch {
      const node = value.current, selection = window.getSelection();
      if (node && selection) { const range = document.createRange(); range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range); }
      setCopy('selected');
    }
  };
  return <div className="revealed">
    <p className="label">{reveal.app === 'whatsapp' ? 'Send this to Waldo on WhatsApp' : REVEAL_LABEL[reveal.kind]}</p>
    <p className="revealed-value" ref={value}>{reveal.value}</p>
    {reveal.app === 'whatsapp' && reveal.to && <p>Send it to <strong>{reveal.to}</strong>. <a className="button primary" href={waLink(reveal.to, reveal.value)}>Open WhatsApp</a> and tap Send.</p>}
    {reveal.app !== 'whatsapp' && reveal.kind === 'link_code' && reveal.to && <p>Send it to <strong>{reveal.to}</strong>. On your iPhone, <a className="button primary" href={smsLink(reveal.to, reveal.value)}>Open Messages</a> and tap Send.</p>}
    <div className="control-actions">
      <button type="button" onClick={() => void onCopy()}>{copy === 'copied' ? 'Copied' : copy === 'selected' ? 'Selected. Press Command-C to copy' : 'Copy'}</button>
    </div>
    <p className="meta">Shown only here, once. Your receipts don’t keep it; get a new one if you lose it.</p>
  </div>;
}

type Bridge = IMessageRecord['data']['bridges'][number];
type BridgeLive = IMessageRecord['status']['bridges'][number];
const bridgeHealth = (bridge: Bridge, live: BridgeLive | undefined) => bridge.state !== 'active' ? null
  : !live ? 'Status unknown' : [live.online ? 'Online' : 'Offline', live.text_ready ? 'text verified' : 'text not verified', ...(live.sending_paused ? ['sending paused after an uncertain send'] : [])].join(' · ');
function HostRow({ bridge, live, busy, onAction }: { bridge: Bridge; live: BridgeLive | undefined } & Actions) {
  const shared = bridge.kind === 'shared';
  const [subject, setSubject] = useState(bridge.subject ?? '');
  const [chat, setChat] = useState(bridge.chat ?? '');
  const sender = subject.trim(), direct = chat.trim() || (sender ? `iMessage;-;${sender}` : '');
  const health = bridgeHealth(bridge, live);
  return <details name="imessage-hosts" className="disclosure">
    <summary><span className="value">{shared ? 'Shared Waldo number' : bridge.subject ?? 'Mac host'}</span><span className={`access-label${bridge.state === 'active' ? ' done' : bridge.state === 'pending' ? ' needs' : ''}`}>{bridge.state}</span></summary>
    <div className="disclosure-body">
      {health && <p>{health}</p>}
      <p className="meta">Host {bridge.host_version}{bridge.subject && bridge.chat ? ` · ${shared ? 'challenge sender' : 'sender'} ${bridge.subject} in ${bridge.chat}` : ''}</p>
      {bridge.actions.includes('imessage.verify') && <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('imessage.verify', { id: bridge.id, subject: sender, chat: direct }); }}>
        <p>{bridge.observed ? 'Waldo saw the challenge from this sender. Confirm it below, or set a different sender for a new challenge.' : 'Set the exact sender, then send the challenge you get from that sender to your Mac’s Messages account.'}</p>
        <div className="control-fields"><label>{shared ? 'Your challenge sender' : 'Your Apple ID sender'}<input required autoComplete="off" value={subject} disabled={busy} onChange={event => setSubject(event.target.value)}/></label>
          <label>Direct chat<input autoComplete="off" value={chat} placeholder={`iMessage;-;${sender || 'sender'}`} disabled={busy} onChange={event => setChat(event.target.value)}/></label></div>
        <div className="control-actions"><button disabled={busy || !sender}>Get a challenge</button></div>
      </form>}
      <div className="control-actions">
        {bridge.actions.includes('imessage.activate') && <button className="primary" disabled={busy} onClick={() => onAction('imessage.activate', { id: bridge.id })}>Confirm {bridge.subject} in {bridge.chat}</button>}
        {bridge.actions.includes('imessage.activate_shared') && <button className="primary" disabled={busy} onClick={() => onAction('imessage.activate_shared', { id: bridge.id })}>Activate the shared Waldo number</button>}
        {bridge.actions.includes('imessage.revoke') && <button disabled={busy} onClick={() => { if (window.confirm('Revoke this Mac host? It stops sending and receiving for your Waldo at once.')) onAction('imessage.revoke', { id: bridge.id }); }}>Revoke this host</button>}
      </div>
    </div>
  </details>;
}

export function IMessageControls({ record, busy, onAction }: { record: IMessageRecord } & Actions) {
  const { data } = record, live = new Map(record.status.bridges.map(row => [row.id, row]));
  const [phone, setPhone] = useState(data.phone ?? '');
  if (!data.enabled) return <section className="panel"><h2>iMessage isn’t enabled on this server.</h2><p>Nothing here can link a number or pair a Mac host until it is.</p></section>;
  const offered = (action: IMessageRecord['data']['actions'][number]) => data.actions.includes(action);
  const hosts = (kind: Bridge['kind']) => data.bridges.filter(bridge => bridge.kind === kind);
  const list = (rows: Bridge[], empty: string) => rows.length ? <div className="disclosures">{rows.map(bridge => <HostRow key={`${record.revision}:${bridge.id}`} bridge={bridge} live={live.get(bridge.id)} busy={busy} onAction={onAction}/>)}</div> : <p className="meta">{empty}</p>;
  return <>
    <section className="tile" aria-labelledby="imessage-link-title">
      <div className="chart-head"><h2 id="imessage-link-title">Text Waldo from your iPhone</h2><span className={`access-label${data.linked_hint ? ' done' : ''}`}>{data.linked_hint ? 'Linked' : 'Not linked'}</span></div>
      {data.address
        ? <p>Your Waldo number is <strong>{data.address}</strong>. Get a one-time code, then text <strong>waldo</strong> and the code to it from your iPhone. Only your own number reaches your Waldo.</p>
        : <p>Enter your iPhone number. Waldo gives you a number to text and a one-time code to send it.</p>}
      {data.linked_hint && <p>Linked: •••{data.linked_hint}. Texts from this number reach your Waldo.</p>}
      {data.phone_on_file && (data.phone_on_file.verified
        ? <p>Your number on file, <strong>{data.phone_on_file.phone}</strong>, is verified.</p>
        : <p>Your number on file, <strong>{data.phone_on_file.phone}</strong>, is not verified yet. To verify it, text your link code to Waldo from that number.</p>)}
      {offered('imessage.enroll') && !data.address && <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('imessage.enroll', { phone }); }}>
        <label>Your iPhone number<input type="tel" autoComplete="tel" placeholder="+15551234567" value={phone} disabled={busy} onChange={event => setPhone(event.target.value)} required/></label>
        <div className="control-actions"><button className="primary" disabled={busy || !phone.trim()}>Get my Waldo number</button></div>
      </form>}
      <div className="control-actions">
        {offered('imessage.link') && <button className="primary" disabled={busy} onClick={() => onAction('imessage.link')}>Get an iMessage link code</button>}
        {offered('imessage.unlink') && <button disabled={busy} onClick={() => { if (window.confirm('Unlink this number? Texts from it stop reaching your Waldo.')) onAction('imessage.unlink'); }}>Unlink this number</button>}
      </div>
      <p className="meta">Direct iMessages only. Waldo tells you when it can’t open a photo or file here. Groups, SMS, voice notes and reactions aren’t supported.</p>
    </section>
    <section className="tile" aria-labelledby="imessage-host-title">
      <div className="chart-head"><h2 id="imessage-host-title">Your own Mac host</h2></div>
      <p>Pair a Mac that runs the Waldo iMessage host, then confirm the one sender it answers.</p>
      {offered('imessage.pair') && <div className="control-actions"><button disabled={busy} onClick={() => onAction('imessage.pair')}>Pair a Mac host</button></div>}
      {list(hosts('owner'), 'No Mac host paired.')}
    </section>
    {data.admin && data.photon && <section className="tile" aria-labelledby="imessage-photon-title">
      <div className="chart-head"><h2 id="imessage-photon-title">Photon</h2><span className={`access-label${data.photon === 'connected' ? ' done' : ''}`}>{data.photon === 'connected' ? 'Connected' : 'Not connected'}</span></div>
      <p>{data.photon === 'connected' ? 'Owners get their Waldo number automatically.' : 'Owners can’t get a Waldo number until an operator connects Photon.'}</p>
      <div className="control-actions"><a className="button" href="/console/imessage/photon/start">{data.photon === 'connected' ? 'Reconnect Photon' : 'Connect Photon'}</a></div>
    </section>}
    {data.admin && <section className="tile" aria-labelledby="imessage-shared-title">
      <div className="chart-head"><h2 id="imessage-shared-title">Shared Waldo number</h2><span className="access-label">Operator</span></div>
      <p>Pairs the host that runs the shared Waldo number for everyone. Each sender still reaches only their own Waldo.</p>
      {offered('imessage.pair_shared') && <div className="control-actions"><button disabled={busy} onClick={() => onAction('imessage.pair_shared')}>Pair the shared number’s host</button></div>}
      {list(hosts('shared'), 'No shared number host paired.')}
    </section>}
  </>;
}

type Device = DevicesRecord['data']['devices'][number];
type DeviceLive = DevicesRecord['status']['devices'][number];
const CAPABILITY_LABEL: Record<string, string> = { machine_state_query: 'Mac state', notify_local: 'Notifications', shell_exec: 'Commands', session_query: 'Session status', session_control: 'Session control' };
function DeviceRow({ device, live, kinds, bodies, busy, onAction }: { device: Device; live: DeviceLive | undefined; kinds: string[]; bodies: string[] } & Actions) {
  const [kind, setKind] = useState(kinds[0] ?? '');
  const [body, setBody] = useState(bodies[0] ?? '');
  const [severity, setSeverity] = useState('info');
  return <details name="devices" className="disclosure">
    <summary><span className="value">{device.label}</span><span className={`access-label${live?.online ? ' done' : ''}`}>{!live ? 'Status unknown' : live.online ? 'Online' : 'Offline'}</span></summary>
    <div className="disclosure-body">
      <p className="meta">Paired {device.created_at} · Last seen {live?.last_seen_at ?? 'never'}</p>
      <ul className="grant-list">{device.capabilities.map(capability => <li key={capability}>{CAPABILITY_LABEL[capability] ?? capability}</li>)}</ul>
      {device.actions.includes('device.query') && <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('device.query', { id: device.id, query_kind: kind }); }}>
        <label>Ask your Mac<select value={kind} disabled={busy} onChange={event => setKind(event.target.value)}>{kinds.map(option => <option key={option} value={option}>{option.replace(/_/g, ' ')}</option>)}</select></label>
        <div className="control-actions"><button disabled={busy || !kind}>Ask Mac state</button></div>
      </form>}
      {device.actions.includes('device.notify') && <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('device.notify', { id: device.id, body, severity }); }}>
        <div className="control-fields"><label>Notification text<select value={body} disabled={busy} onChange={event => setBody(event.target.value)}>{bodies.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
          <label>Level<select value={severity} disabled={busy} onChange={event => setSeverity(event.target.value)}><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></select></label></div>
        <div className="control-actions"><button disabled={busy || !body}>Send this notification to my Mac</button></div>
      </form>}
      {!!live?.commands.length && <><p className="label">Recent requests</p><ul className="session-list">{live.commands.map((command, index) => <li key={index}>{command.class}: {command.state}{command.result_state ? ` (${command.result_state})` : ''}</li>)}</ul></>}
      <p className="meta">A queued request isn’t a result: the state above is what your Mac has reported.</p>
      {device.actions.includes('device.revoke') && <div className="control-actions"><button disabled={busy} onClick={() => { if (window.confirm(`Revoke ${device.label}? It can no longer connect to your Waldo.`)) onAction('device.revoke', { id: device.id }); }}>Revoke {device.label}</button></div>}
    </div>
  </details>;
}

export function DevicesControls({ record, busy, onAction }: { record: DevicesRecord } & Actions) {
  const { data } = record, live = new Map(record.status.devices.map(row => [row.id, row]));
  return <>
    <section className="tile" aria-labelledby="devices-pair-title">
      <div className="chart-head"><h2 id="devices-pair-title">Pair a Mac</h2></div>
      <p>Connect Kennel on your Mac to your Waldo.</p>
      <ol className="steps"><li>Get a pairing code here.</li><li>In Kennel, open Settings, then Connect to Waldo.</li><li>Paste the code and select Connect.</li></ol>
      {data.actions.includes('device.pair') && <div className="control-actions"><button className="primary" disabled={busy} onClick={() => onAction('device.pair')}>Get pairing code</button></div>}
      <p className="meta">Each code works once and expires in 10 minutes. If one expires, get a new one.</p>
    </section>
    {data.devices.length ? <div className="tile disclosures">{data.devices.map(device => <DeviceRow key={`${record.revision}:${device.id}`} device={device} live={live.get(device.id)} kinds={data.query_kinds} bodies={data.notification_bodies} busy={busy} onAction={onAction}/>)}</div>
      : <section className="panel"><h2>No devices yet.</h2><p>Paired Macs appear here once Kennel connects with a code.</p></section>}
  </>;
}

const clockTime = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// The number on file and how to prove it. The code lives only in this form's state and the one request that checks it.
export function PhoneControls({ record, busy, onAction }: { record: PhoneRecord } & Actions) {
  const { data } = record, challenge = data.challenge;
  const [code, setCode] = useState('');
  const offered = (action: PhoneRecord['data']['actions'][number]) => data.actions.includes(action);
  const digits = code.replace(/\s/g, '');
  return <section className="tile" aria-labelledby="phone-title">
    <div className="chart-head"><h2 id="phone-title">Your phone</h2>{data.phone && <span className={`access-label${data.verified ? ' done' : ' needs'}`}>{data.verified ? 'Verified' : 'Not verified yet'}</span>}</div>
    {!data.phone ? <p>There is no phone number on file.</p> : data.verified ? <p>Your number on file, <strong>{data.phone}</strong>, is verified.</p> : <>
      <p>Your number on file, <strong>{data.phone}</strong>, is not verified yet. Waldo sends nothing to it until it is.</p>
      <p>To verify it, <a href="#/connections/imessage">link iMessage</a> and text your link code to Waldo from that number.{data.sms && ' Or have a six-digit code texted to it: Twilio sends the text.'}</p>
      {challenge?.state === 'pending' && <p>A code was texted to this number. It works until {clockTime(challenge.expires_at)}.</p>}
      {challenge?.state === 'unknown' && <p>Twilio did not confirm the last text.</p>}
      {challenge?.state === 'expired' && <p>No code is waiting for this number.</p>}
      {data.sms && !offered('phone.sms_send') && challenge?.retry_at && <p className="meta">You can ask for another code after {clockTime(challenge.retry_at)}. Refresh then.</p>}
      {offered('phone.sms_send') && <div className="control-actions"><button disabled={busy} onClick={() => onAction('phone.sms_send')}>{challenge?.state === 'pending' ? 'Text the code again' : 'Text me a code'}</button></div>}
      {offered('phone.sms_check') && <form className="control-form" onSubmit={event => { event.preventDefault(); onAction('phone.sms_check', { code: digits }); }}>
        <label>Code from the text<input inputMode="numeric" autoComplete="one-time-code" maxLength={11} value={code} disabled={busy} onChange={event => setCode(event.target.value)} required/></label>
        <div className="control-actions"><button className="primary" disabled={busy || !/^\d{6}$/.test(digits)}>Verify my number</button></div>
      </form>}
    </>}
  </section>;
}
