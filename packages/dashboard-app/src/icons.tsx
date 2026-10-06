import type { CSSProperties } from 'react';
import today from './assets/icons/today.svg?inline';
import waiting from './assets/icons/waiting.svg?inline';
import memory from './assets/icons/memory.svg?inline';
import patrol from './assets/icons/patrol.svg?inline';
import settings from './assets/icons/settings.svg?inline';
import brief from './assets/icons/brief.svg?inline';
import spot from './assets/icons/spot.svg?inline';
import calendar from './assets/icons/calendar.svg?inline';
import calendarClock from './assets/icons/calendar-clock.svg?inline';
import envelope from './assets/icons/envelope.svg?inline';
import paperplane from './assets/icons/paperplane.svg?inline';
import checklist from './assets/icons/checklist.svg?inline';
import close from './assets/icons/close.svg?inline';
import entry from './assets/icons/entry.svg?inline';
import warning from './assets/icons/warning.svg?inline';
import person from './assets/icons/person.svg?inline';
import bell from './assets/icons/bell.svg?inline';
import check from './assets/icons/ui-check.svg?inline';
import pending from './assets/icons/ui-pending.svg?inline';
import retry from './assets/icons/ui-retry.svg?inline';
import chevron from './assets/icons/ui-chevron.svg?inline';
import arrow from './assets/icons/ui-arrow.svg?inline';
import chat from './assets/icons/ui-chat.svg?inline';
import sun from './assets/icons/ui-sun.svg?inline';
import moon from './assets/icons/ui-moon.svg?inline';
import graph from './assets/icons/graph.svg?inline';
import gmail from './assets/logos/gmail.svg?inline';
import googleCalendar from './assets/logos/google-calendar.svg?inline';
import telegram from './assets/logos/telegram.svg?inline';

// Lucide static 1.52.0, ISC / Feather-derived MIT. Notices in assets/icons/LICENSE.txt.
const glyphs = { today, waiting, memory, patrol, settings, brief, spot, calendar, calendarClock, envelope, paperplane, checklist, close, entry, warning, person, bell, check, pending, retry, chevron, arrow, chat, sun, moon, graph };
export type IconName = keyof typeof glyphs;
export const Icon = ({ name, className }: { name: IconName; className?: string }) =>
  <span className={className ? `icon ${className}` : 'icon'} style={{ '--icon': `url("${glyphs[name]}")` } as CSSProperties} aria-hidden="true"/>;

// Real connector marks; a source app is never drawn as a generic glyph when its logo exists.
const logos = { gmail, googleCalendar, telegram };
export type LogoName = keyof typeof logos;
export const Logo = ({ name }: { name: LogoName }) => <img className="logo" src={logos[name]} alt="" aria-hidden="true"/>;

// Waldo's mark, exactly as the landing's nav draws it (waldo-landing components/site/site-nav.tsx).
const SPOTS = [
  'M12.0455 8.19435C8.5546 8.63273 6.68628 1.37044 10.4049 0.0167778C14.1721 -0.400611 15.7586 7.09811 12.0455 8.19435Z',
  'M8.3092 10.5135C6.58923 13.9893 -0.949651 11.5404 0.0997341 7.32816C2.00498 3.60923 9.58249 6.4543 8.3092 10.5135Z',
  'M16.2786 9.83065C13.9189 7.43667 17.1194 2.50187 20.161 4.61989C22.6742 7.23047 19.1635 12.07 16.2786 9.83065Z',
  'M17.6058 13.2603C18.102 11.0572 22.6427 11.375 22.6197 13.8989C22.0525 16.2652 17.4372 15.7294 17.6058 13.2603Z',
  'M14.9478 15.3381C16.0796 14.5281 18.5029 18.2428 17.5123 19.5964C16.2774 20.4397 13.8966 16.5483 14.9478 15.3381Z',
  'M12.4438 16.4828C13.658 16.5976 13.532 19.6799 12.1468 19.9149C10.8424 19.7685 11.0872 16.6145 12.4438 16.4828Z',
  'M8.14378 17.1963C7.28218 17.5051 6.42602 17.6249 5.54174 17.3248C4.67747 17.041 4.12053 16.212 4.48021 15.3153C4.77929 14.5697 5.47458 14.0913 6.18381 13.7831C9.6415 12.3095 11.8426 15.68 8.14378 17.1963Z',
];
export const WaldoMark = ({ size = 18 }: { size?: number }) =>
  <svg className="waldo-mark" width={size} height={(size * 20) / 23} viewBox="0 0 23 20" fill="currentColor" aria-hidden="true">{SPOTS.map((d, i) => <path key={i} d={d}/>)}</svg>;
