import { ControlsPanel } from './Controls';
import { OwnerControlsPanel } from './OwnerControls';
export type SettingsSection = 'day' | 'sessions' | 'usage' | 'account' | 'setup';
const sections = [{key:'day',label:'Day & notifications'},{key:'sessions',label:'Sessions'},{key:'usage',label:'Usage'},{key:'account',label:'Account & privacy'},{key:'setup',label:'Setup'}] as const;
export function SettingsNavigation({selected}:{selected:SettingsSection}) {return <nav className="settings-tabs" aria-label="Settings sections">{sections.map(item=><a key={item.key} aria-current={selected===item.key?'page':undefined} href={`#/settings/${item.key}`}>{item.label}</a>)}</nav>;}
export function SettingsPanel({section}:{section:SettingsSection}) {return <><div className="page-heading"><h1>Settings.</h1></div><SettingsNavigation selected={section}/>{section==='account'?<OwnerControlsPanel view="account" embedded/>:<ControlsPanel key={section} view={section==='sessions'?'connections':section} embedded section={section==='sessions'?'sessions':undefined}/>}</>;}
