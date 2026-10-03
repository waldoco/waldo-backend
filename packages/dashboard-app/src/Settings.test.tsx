import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {DashboardNavigation,resolveRoute} from './App';
import {SettingsNavigation} from './Settings';
import type {ConnectionsRecord} from './controls-model';
import {ConnectionsControls} from './Controls';
const connection:ConnectionsRecord={version:1,view:'connections',state:'available',csrf:'fixture',revision:'fixture',data:{google:{connectAvailable:true,accounts:[]},telegram:{linked:false,unlinkAvailable:true},sessions:{count:2,until:'2026-10-04T09:00:00Z'}}};
describe('simplified console shell',()=>{
 it('groups day, sessions, usage, account and setup under Settings instead of repeating sidebar destinations',()=>{
  const html=renderToStaticMarkup(<DashboardNavigation route="settings/sessions"/>);
  expect(html).toContain('href="#/settings"');
  for(const href of ['#/day','#/usage','#/account','#/setup'])expect(html).not.toContain(`href="${href}"`);
  expect(html).toContain('href="#/connections"');expect(html).toContain('href="#/files"');expect(html).toContain('href="/console/legacy"');
 });
 it('supports settings destinations and deliberate old links',()=>{
  for(const route of ['settings','settings/day','settings/sessions','settings/usage','settings/account','settings/setup'])expect(resolveRoute(route)).toBe(route);
  for(const route of ['day','usage','account','setup'])expect(resolveRoute(route)).toBe(route);
 });
 it('has named subnavigation with the active section',()=>{
  const html=renderToStaticMarkup(<SettingsNavigation selected="sessions"/>);
  expect(html).toContain('aria-label="Settings sections"');expect(html).toMatch(/aria-current="page"[^>]*href="#\/settings\/sessions"/);expect(html).toContain('Day &amp; notifications');
 });
 it('opens sessions without exposing Google/Telegram controls and keeps channel setup free of session controls',()=>{
  const sessions=renderToStaticMarkup(<ConnectionsControls record={connection} busy={false} onAction={()=>{}} section="sessions"/>);
  expect(sessions).toContain('Sign out everywhere');expect(sessions).not.toContain('Google accounts');expect(sessions).not.toContain('Link a Telegram');
  const channels=renderToStaticMarkup(<ConnectionsControls record={connection} busy={false} onAction={()=>{}} section="connections"/>);
  expect(channels).toContain('Google accounts');expect(channels).not.toContain('Sign out everywhere');
 });
});
