import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {SettingsNavigation} from './Settings';
import {DashboardNavigation} from './App';
import {ProfileCards} from './Profile';
import {Pipeline} from './Infographics';
it('makes Setup and Sessions discoverable and restores the waiting badge',()=>{
 const tabs=renderToStaticMarkup(<SettingsNavigation selected="day"/>);
 expect(tabs).toContain('href="#/settings/setup"');expect(tabs).toContain('href="#/settings/sessions"');
 expect(renderToStaticMarkup(<DashboardNavigation route="today" waitingCount={2}/>)).toContain('2 waiting decisions');
});
it('offers all returned profile facts for inspection',()=>{
 const html=renderToStaticMarkup(<ProfileCards sections={[{title:'Rhythm',lines:['Morning','Evening']}]}/>);
 expect(html).toContain('Show all saved context');expect(html).toContain('<li>Evening</li>');
});
it('keeps independently recorded step times and notes inspectable',()=>{
 const html=renderToStaticMarkup(<Pipeline steps={[{step:'Read',state:'ok',at:'2026-10-01T03:00:00Z',note:'Receipt unverified'}]}/>);
 expect(html).toContain('2026-10-01T03:00:00Z');expect(html).toContain('Receipt unverified');
});
