import { ControlsPanel } from './Controls';
import { OwnerControlsPanel } from './OwnerControls';
export type SettingsSection = 'day' | 'sessions' | 'usage' | 'account' | 'setup';
export type SettingsTab = 'day' | 'connections' | 'files' | 'usage' | 'account' | 'invites' | 'admin' | 'admin-health' | 'health' | 'vault' | 'setup' | 'sessions';
const tabs: { key: SettingsTab; label: string; href: string }[] = [
  { key: 'day', label: 'Your day', href: '#/settings/day' }, { key: 'connections', label: 'Connections', href: '#/connections' },
  { key: 'health', label: 'Health', href: '#/health' }, { key: 'vault', label: 'Vault', href: '#/vault' },
  { key: 'files', label: 'Files', href: '#/files' }, { key: 'usage', label: 'Usage', href: '#/settings/usage' },
  {key:'setup',label:'Setup',href:'#/settings/setup'}, {key:'sessions',label:'Sessions',href:'#/settings/sessions'},
  { key: 'account', label: 'Account', href: '#/settings/account' }, { key: 'invites', label: 'Invites', href: '#/invites' },
];
export const settingsTab = (section: SettingsSection): SettingsTab | null => section;
export function SettingsNavigation({ selected, isAdmin = false }: { selected: SettingsTab | null; isAdmin?: boolean }) {
  const items = isAdmin ? [...tabs, { key: 'admin' as const, label: 'Invite management', href: '#/admin' }, { key: 'admin-health' as const, label: 'Tester health', href: '#/admin/health' }] : tabs;
  return <nav className="segmented" aria-label="Settings sections">{items.map(item => <a key={item.key} aria-current={selected === item.key ? 'page' : undefined} href={item.href}>{item.label}</a>)}</nav>;
}
export function SettingsHead({ selected, isAdmin = false }: { selected: SettingsTab | null; isAdmin?: boolean }) {
  return <><div className="page-heading"><h1>Settings.</h1></div><SettingsNavigation selected={selected} isAdmin={isAdmin}/></>;
}
export function SettingsPanel({ section, isAdmin = false }: { section: SettingsSection; isAdmin?: boolean }) {
  return <><SettingsHead selected={settingsTab(section)} isAdmin={isAdmin}/>
    {section==='sessions'?<ControlsPanel key="sessions" view="connections" embedded section="sessions"/>:section === 'account' ? <><OwnerControlsPanel view="account" embedded/><ControlsPanel key="sessions" view="connections" embedded section="sessions"/></>
      : <ControlsPanel key={section} view={section} embedded/>}</>;
}
