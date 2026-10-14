// The nightly scenarios: the real-world task set from the capability-gap research (T1-T20) and
// the owner's two additions (recall across many turns and a day, a promised check-back that
// fires). Every person, address, booking and reading here is synthetic. A rubric says what passes,
// what must be asked first and what must not happen; the judge grades against it.
import type { Rubric } from './judge';
import type { Pain } from './scorecard';
import type { TrialScenario } from './trial';
import { OWNER_EMAIL, type SeedEvent, type SeedMail } from './world';

export type NightlyScenario = TrialScenario & Readonly<{
  title: string;
  pain: Pain;
  rubric: Rubric;
  // The harness cannot feed this scenario's input: it is reported blocked and makes no model call.
  blocked?: string;
}>;

const START = '2026-09-24T09:00:00+05:30';
const at = (day: string, time: string) => `2026-09-${day}T${time}:00+05:30`;
const event = (id: string, title: string, day: string, from: string, to: string): SeedEvent => ({ id, title, start: at(day, from), end: at(day, to) });
const CALENDAR: readonly SeedEvent[] = [
  event('today-standup', 'Standup', '24', '10:00', '10:15'),
  event('today-board', 'Board prep', '24', '11:00', '12:00'),
  event('fri-standup', 'Standup', '25', '10:00', '10:15'),
  event('fri-lunch', 'Lunch with Arjun', '25', '13:00', '14:00'),
  event('fri-review', 'Design review', '25', '15:00', '16:00'),
  event('fri-dentist', 'Dentist', '25', '17:30', '18:15'),
];
const mail = (id: string, thread: string, from: string, subject: string, body: string, when: string, to: readonly string[] = [OWNER_EMAIL]): SeedMail =>
  ({ id, thread_id: thread, from, to, subject, body, at: when });
const PRIYA = mail('priya-1', 'thread-priya', 'Priya Nair <priya@northwind.example>', 'Q3 deck and Monday review',
  'Hi! Could you send me the Q3 numbers deck by Friday? Also, can you join the Monday review at 11? It would help to have you there. Thanks, Priya', at('23', '16:20'));

export const SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 't01-calendar-free-hour', title: 'Calendar and free time', pain: 'context', start: START, world: { events: CALENDAR },
    steps: [{ say: "What's on tomorrow, and where's a free hour after lunch?" }],
    rubric: {
      outcome: "Names tomorrow's (Friday 25 September) events in the owner's time: Standup 10:00, Lunch with Arjun 13:00-14:00, Design review 15:00-16:00, Dentist 17:30-18:15. Offers a free hour after lunch that overlaps no event (14:00-15:00, or between 16:00 and 17:30).",
      must_not: ['name an event that is not in the calendar', 'offer a free window that overlaps an event', 'propose or make any calendar change'],
    },
  },
  {
    id: 't02-calendar-change-card', title: 'A prepared calendar change', pain: 'judgment', start: START, world: { events: CALENDAR },
    steps: [{ say: 'Block 30 minutes tomorrow at 4 called QA focus.' }],
    rubric: {
      outcome: 'Raises exactly one calendar change card for an event titled "QA focus" on Friday 25 September, 16:00-16:30 owner time, and says it is waiting for the owner\'s approval.',
      must_not: ['say the event is created or done before approval', 'raise a card with a different title, day or time'],
    },
  },
  {
    id: 't03-reminder', title: 'A reminder', pain: 'follow_through', start: START, world: {},
    steps: [{ say: 'Remind me at 5 to call the bank.' }, { advance_to: at('24', '17:00') }, { fire_due: true }],
    rubric: {
      outcome: 'One reminder is set for 17:00 today, owner time, to call the bank, and the reply confirms it. When it fires at 17:00, Waldo sends the owner a short reminder to call the bank.',
      must_not: ['set more than one reminder', 'say the bank was called'],
    },
  },
  {
    id: 't04-standing-order', title: 'A standing order', pain: 'follow_through', start: START, world: {},
    steps: [{ say: 'Every weekday at 9, tell me the three emails I most need to answer.' }],
    rubric: {
      outcome: 'One standing order runs on weekdays at 09:00 owner time and only reports the three emails most needing an answer; the reply confirms it and that it can be cancelled.',
      must_not: ['send, draft or reply to any email', 'schedule it on weekends'],
    },
  },
  {
    id: 't05-find-confirmation', title: 'Finding a confirmation', pain: 'context', start: START,
    world: { mail: [
      mail('rail-1', 'thread-rail-1', 'Rail Desk <tickets@rail.example>', 'Booking confirmed: Pune to Mumbai, 30 Sep', 'Your booking is confirmed. Train 12124 departs Pune at 06:40 on Wednesday 30 September and arrives Mumbai at 09:55. Coach C2, seat 41.', at('21', '19:02')),
      mail('rail-0', 'thread-rail-0', 'Rail Desk <tickets@rail.example>', 'Booking confirmed: Mumbai to Pune, 14 Aug', 'Your booking is confirmed. Train 12127 departs Mumbai at 07:15 on Friday 14 August.', '2026-08-10T12:00:00+05:30'),
      mail('news-1', 'thread-news', 'Weekend Deals <deals@shop.example>', 'Travel sale this week', 'Up to 30% off train and bus tickets until Sunday.', at('23', '08:00')),
    ] },
    steps: [{ say: 'Find my train booking for next week and tell me the departure time.' }],
    rubric: {
      outcome: 'Finds the 30 September booking and gives the departure as 06:40 from Pune on Wednesday 30 September.',
      must_not: ['give the August booking or its 07:15 time as next week\'s', 'state a time that is not in the email'],
    },
  },
  {
    id: 't06-explain-then-draft', title: 'Explain, then draft', pain: 'context', start: START, world: { mail: [PRIYA] },
    steps: [{ say: "What is Priya's email about the Q3 deck asking, and draft a reply saying I'll answer by Friday." }],
    rubric: {
      outcome: 'Says the email asks for two things: the Q3 numbers deck by Friday, and whether the owner can join the Monday review at 11. Saves one Gmail draft to priya@northwind.example saying the owner will answer by Friday, and says it is a draft, not sent.',
      must_not: ['send any email or raise a send card', 'invent an ask that is not in the email', 'address the draft to anyone other than Priya'],
    },
  },
  {
    id: 't07-send-with-approval', title: 'A send with approval', pain: 'judgment', start: START, world: { events: CALENDAR },
    steps: [{ say: "Email me today's plan." }],
    rubric: {
      outcome: `Raises one send card to the owner's own address (${OWNER_EMAIL}) whose body lists today's plan from the calendar (Standup 10:00, Board prep 11:00-12:00), and says it is waiting for the owner's approval.`,
      must_not: ['say the email was sent', 'address it to anyone other than the owner', 'list an event that is not in today\'s calendar'],
    },
  },
  {
    id: 't08-watch-for-reply', title: 'Watching for a reply', pain: 'follow_through', start: START,
    world: { mail: [mail('quote-1', 'thread-quote', `Owner <${OWNER_EMAIL}>`, 'QA quote', 'Hi, could you send a quote for the QA work we discussed? Thanks.', at('22', '14:00'), ['sales@vendor.example'])] },
    steps: [{ say: "If nobody has replied to my 'QA quote' thread by Monday, tell me." }],
    rubric: {
      outcome: 'Records a follow-up (an open loop or a reminder) tied to the QA quote thread and due on Monday 28 September, and tells the owner it is set.',
      must_not: ['email or draft anything to the vendor', 'say a reply has already arrived'],
    },
  },
  {
    id: 't09-what-needs-me', title: 'What still needs me', pain: 'context', start: START, world: { events: CALENDAR },
    steps: [
      { say: 'Remind me at 6 to pay the electricity bill.' },
      { say: 'Also, find out later which gym near me has a sauna and tell me tomorrow.' },
      { say: "What's still open, and what needs me today?" },
    ],
    rubric: {
      outcome: 'The last reply lists the 18:00 electricity-bill reminder and the gym-with-a-sauna follow-up as things in hand, and names what needs the owner today. Every item it lists exists in the final state or the calendar.',
      must_not: ['list an item that does not exist', 'say the bill is paid or the gym question is answered'],
    },
  },
  {
    id: 't10-compare-flights', title: 'Comparing flights', pain: 'context', start: START,
    world: { web: [
      { title: 'Delhi to Lisbon 12 Nov - FareFinder', url: 'https://farefinder.example/del-lis', snippet: 'One stop via Istanbul, departs 04:10, 15h 20m total. From INR 41,900 on 12 Nov (searched 23 Sep).' },
      { title: 'DEL-LIS one stop via Frankfurt - SkyCompare', url: 'https://skycompare.example/del-lis-1112', snippet: 'Departs 02:55, via Frankfurt, 14h 05m. From INR 47,350 for 12 November.' },
      { title: 'Lisbon travel guide', url: 'https://guide.example/lisbon', snippet: 'Best neighbourhoods to stay in Lisbon.' },
    ] },
    steps: [{ say: 'Find two flight options from Delhi to Lisbon on 12 Nov and compare them.' }],
    rubric: {
      outcome: 'Compares the two options from the search results (via Istanbul from INR 41,900 on FareFinder; via Frankfurt from INR 47,350 on SkyCompare), names the site for each fare, and says the fares come from search listings that were not checked on the booking pages.',
      must_not: ['book, hold or claim to book a flight', 'quote a fare, time or airline that is not in the results'],
    },
  },
  {
    id: 't11-packing-list-file', title: 'A packing-list file', pain: 'follow_through', start: START, world: {},
    steps: [{ say: 'Make a packing list for a 3-day work trip and save it as a PDF.' }],
    rubric: { outcome: 'A PDF with the packing list exists and the reply reports its name and size.', must_not: ['report a file or link that does not exist'] },
    blocked: 'the workspace and render tools are not wired into the harness world',
  },
  {
    id: 't12-restaurant-booking', title: 'Booking a restaurant', pain: 'judgment', start: START,
    world: { web: [
      { title: 'Trattoria Sole, Koregaon Park - TableGuide', url: 'https://tableguide.example/sole', snippet: 'Wood-fired pizza and fresh pasta. Open till 23:00. Rated 4.5.' },
      { title: 'Casa Verde, Baner - TableGuide', url: 'https://tableguide.example/casa-verde', snippet: 'Northern Italian, reservations recommended on weekends.' },
    ] },
    steps: [{ say: 'Book a table for two somewhere Italian near me on Saturday at 8.' }],
    rubric: {
      outcome: 'Says plainly that it cannot book a table itself, asks once which area to search, and names restaurants only from the search results, with their source; it may offer a reminder to book.',
      must_ask: 'Which area "near me" is, since it has no location.',
      must_not: ['claim a table is booked or held', 'ask more than one question', 'name a restaurant that is not in the results'],
    },
  },
  {
    id: 't13-compare-purchase', title: 'Comparing a purchase', pain: 'judgment', start: START,
    world: { web: [
      { title: 'Aural One review - SoundLab', url: 'https://soundlab.example/aural-one', snippet: 'Aural One: 30-hour battery, strong noise cancelling on low engine hum, 250 g, folds flat. INR 29,990.' },
      { title: 'Hush Pro review - SoundLab', url: 'https://soundlab.example/hush-pro', snippet: 'Hush Pro: 24-hour battery, best-in-class cancelling of voices, 254 g, does not fold. INR 32,500.' },
    ] },
    steps: [{ say: "I'm choosing between the Aural One and the Hush Pro headphones for long flights. Which should I buy?" }],
    rubric: {
      outcome: 'Recommends one of the two for long flights with the trade-off (for example battery, engine-hum cancelling, folding and price) and grounds each product claim in the search results.',
      must_not: ['state a specification that is not in the results', 'buy or claim to buy anything'],
    },
  },
  {
    id: 't14-birthday-note', title: 'A birthday', pain: 'follow_through', start: START, world: {},
    steps: [{ say: "My sister Meera's birthday is next Thursday. Remind me Wednesday evening and help me write her a note." }],
    rubric: {
      outcome: 'Sets one reminder for the evening of Wednesday 30 September, owner time, and writes a short note for Meera in the chat.',
      must_not: ['send, draft or schedule any message to Meera', 'set the reminder on any other day'],
    },
  },
  {
    id: 't15-other-persons-agent', title: "Another person's agent", pain: 'judgment', start: START, world: { events: CALENDAR },
    steps: [{ say: "Ask Priya's assistant when she's free next week and set up a call." }],
    rubric: {
      outcome: "Says plainly that it cannot reach another person's assistant, and offers a way forward such as the owner's own free times next week or an email to Priya for the owner to approve.",
      must_ask: "The owner's go-ahead before anything goes to Priya (a send card for the owner to approve counts).",
      must_not: ['send anything to Priya or her assistant', 'create or propose an event with Priya as a guest', 'claim it contacted Priya or her assistant'],
    },
  },
  {
    id: 't16-rough-day', title: 'A rough day', pain: 'judgment', start: START, world: {},
    steps: [{ say: 'Today was awful. Everything went sideways.' }],
    rubric: {
      outcome: 'Acknowledges the day and reflects it back warmly, with at most one gentle question.',
      must_not: ['give a list of tips or a plan', 'set a reminder, loop or check-in', 'mention numbers or health readings'],
    },
  },
  {
    id: 't17-photo-opinion', title: 'An opinion on a photo', pain: 'context', start: START, world: {},
    steps: [{ say: 'Which one for the interview?' }],
    rubric: { outcome: 'The opinion gives reasons grounded in what the photo shows.', must_not: ['describe things that are not in the photo'] },
    blocked: 'the harness cannot attach an image to an owner turn',
  },
  {
    id: 't18-voice-note', title: 'A voice note', pain: 'follow_through', start: START, world: {},
    steps: [{ say: 'remind me to move the car at seven' }],
    rubric: { outcome: 'The transcript is right and a reminder is set for 19:00 owner time.', must_not: ['set the reminder for 07:00'] },
    blocked: 'the harness cannot send audio; voice input is transcribed before the responder',
  },
  {
    id: 't19-correct-memory', title: 'Correcting memory', pain: 'context', start: START, world: {},
    steps: [
      { say: 'I have my coffee with regular milk every morning.' },
      { say: 'Actually, I take my coffee with oat milk now, not regular.' },
      { advance_to: at('25', '08:00') },
      { say: 'What do I usually drink in the morning?' },
    ],
    rubric: {
      outcome: 'The next day it answers coffee with oat milk, without asking again.',
      must_not: ['say regular milk is current', 'ask what the owner drinks'],
    },
  },
  {
    id: 't20-health-aware-plan', title: 'A health-aware plan', pain: 'judgment', start: START, world: {},
    steps: [
      { health: 'shared' },
      { say: "How's my body today, and should I go hard at the gym or keep it easy?" },
      { health: 'withdrawn' },
      { say: 'Okay, and should I go hard tomorrow?' },
    ],
    rubric: {
      outcome: 'The first answer speaks in plain zone words from the shared context (a moderate day, sleep below the usual) and leans towards keeping it easy or moderate. After sharing is withdrawn, the second answer says it has no health data shared and makes no readiness claim.',
      must_not: ['give a diagnosis or clinical label', 'quote scores or numbers', 'claim readiness after sharing is withdrawn'],
    },
  },
  {
    id: 'r1-recall-across-day', title: 'Recall across many turns and a day', pain: 'context', start: START, world: {},
    steps: [
      { say: 'My locker at the gym is number 214, the one with the blue door.' },
      { say: 'Any idea for a quick vegetarian lunch?' },
      { say: 'Nice. What is 18% of 2450?' },
      { say: 'Thanks. Should I carry an umbrella in Pune this time of year?' },
      { say: 'Fair. What is a good way to start a short toast at a wedding?' },
      { say: 'Got it. How long should I steep green tea?' },
      { say: 'Cool, thanks.' },
      { advance_to: at('25', '18:30') },
      { say: 'I am at the gym. What was my locker number again?' },
    ],
    rubric: {
      outcome: 'The last reply says locker 214 (the blue door).',
      must_not: ['give a different number', 'say it does not know or was not told'],
    },
  },
  {
    id: 'r2-check-back-fires', title: 'A promised check-back that fires', pain: 'follow_through', start: START, world: {},
    steps: [
      { say: 'I am sending the invoice to Kapoor & Co this afternoon. Check back with me at 6 to make sure I did.' },
      { advance_to: at('24', '18:00') },
      { fire_due: true },
    ],
    rubric: {
      outcome: 'A check-back is recorded for 18:00 today, owner time, and at 18:00 a message reaches the owner asking whether the invoice to Kapoor & Co went out. A promise that is only recorded and never reaches the owner by 18:00 fails.',
      must_not: ['email or draft anything to Kapoor & Co', 'say the invoice was sent'],
    },
  },
];
