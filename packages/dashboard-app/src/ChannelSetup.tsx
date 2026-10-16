import { useRef, useState } from 'react';
import type { ActionReveal, ControlAction, ControlFields, DevicesRecord, IMessageRecord } from './controls-model';

type Actions = { busy: boolean; onAction: (action: ControlAction, fields?: ControlFields) => void };

const REVEAL_LABEL: Record<ActionReveal['kind'], string> = { link_code: 'Text this from your iPhone', host_code: 'Mac host code', challenge: 'Challenge text', pairing_code: 'Kennel pairing code' };
// The value is shown once. If the clipboard is refused, the whole value is selected so one keystroke copies it.
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
    <p className="label">{REVEAL_LABEL[reveal.kind]}</p>
    <p className="revealed-value" ref={value}>{reveal.value}</p>
    <div className="control-actions">
      {reveal.send_url && <a className="button-link" href={reveal.send_url}>Open Messages</a>}
      <button type="button" onClick={() => void onCopy()}>{copy === 'copied' ? 'Copied' : copy === 'selected' ? 'Selected. Press Command-C to copy' : 'Copy'}</button>
    </div>
    <p className="meta">{reveal.send_url ? 'On your iPhone, tap Open Messages, then Send. ' : ''}Shown only here, once. Your receipts don’t keep it; get a new one if you lose it.</p>
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
  if (!data.enabled) return <section className="panel"><h2>iMessage isn’t enabled on this server.</h2><p>Nothing here can link a number or pair a Mac host until it is.</p></section>;
  const offered = (action: IMessageRecord['data']['actions'][number]) => data.actions.includes(action);
  const hosts = (kind: Bridge['kind']) => data.bridges.filter(bridge => bridge.kind === kind);
  const list = (rows: Bridge[], empty: string) => rows.length ? <div className="disclosures">{rows.map(bridge => <HostRow key={`${record.revision}:${bridge.id}`} bridge={bridge} live={live.get(bridge.id)} busy={busy} onAction={onAction}/>)}</div> : <p className="meta">{empty}</p>;
  return <>
    <section className="tile" aria-labelledby="imessage-link-title">
      <div className="chart-head"><h2 id="imessage-link-title">Text Waldo from your iPhone</h2><span className={`access-label${data.linked_hint ? ' done' : ''}`}>{data.linked_hint ? 'Linked' : 'Not linked'}</span></div>
      <p>Get a one-time code, then text <strong>waldo</strong> and the code to {data.address ?? 'the Waldo iMessage number'} from your iPhone. Only your own number reaches your Waldo.</p>
      {data.linked_hint && <p>Linked: •••{data.linked_hint}. Texts from this number reach your Waldo.</p>}
      <div className="control-actions">
        {offered('imessage.link') && <button className="primary" disabled={busy} onClick={() => onAction('imessage.link')}>Get an iMessage link code</button>}
        {offered('imessage.unlink') && <button disabled={busy} onClick={() => { if (window.confirm('Unlink this number? Texts from it stop reaching your Waldo.')) onAction('imessage.unlink'); }}>Unlink this number</button>}
      </div>
      <p className="meta">Direct iMessage text only. Groups, SMS, files and reactions aren’t supported.</p>
    </section>
    <section className="tile" aria-labelledby="imessage-host-title">
      <div className="chart-head"><h2 id="imessage-host-title">Your own Mac host</h2></div>
      <p>Pair a Mac that runs the Waldo iMessage host, then confirm the one sender it answers.</p>
      {offered('imessage.pair') && <div className="control-actions"><button disabled={busy} onClick={() => onAction('imessage.pair')}>Pair a Mac host</button></div>}
      {list(hosts('owner'), 'No Mac host paired.')}
    </section>
    {data.admin && <section className="tile" aria-labelledby="imessage-shared-title">
      <div className="chart-head"><h2 id="imessage-shared-title">Shared Waldo number</h2><span className="access-label">Operator</span></div>
      <p>Pairs the Mac that runs {data.address ?? 'the Waldo iMessage number'} for everyone. Each sender still reaches only their own Waldo.</p>
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
