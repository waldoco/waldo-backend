// Writing for the medium and staying ahead of the day: mail written as an email, a document written as a document, and an
// afternoon planned with one proposal and only the owner's own decisions asked. Every person and message is synthetic.
import { effects, none, readOnly } from './receipts';
import { CALENDAR, PRIYA, START, at, event, type NightlyScenario } from './scenarios';

export const WRITING_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'm01-email-written-as-email', title: 'A reply written as an email', pain: 'judgment', start: START, world: { mail: [PRIYA], events: CALENDAR },
    steps: [{ say: "Reply to Priya: I'll have the deck to her Thursday and I can do Monday's review. Send it once I've seen it." }],
    rubric: {
      outcome: "Raises one send card to priya@northwind.example. Its body reads as an email from the owner, not a chat message: a greeting to Priya, the deck by Thursday and yes to Monday's review at 11 in short paragraphs, and a closing word. The chat reply is a line or two that points to the card and says it is waiting for the owner's approval, without pasting the email again.",
      must_not: ['say the email was sent', 'address it to anyone other than Priya', 'write the email body as a one-line chat message', 'sign the body with Waldo\'s name or role', 'repeat the whole email in the chat reply'],
      voice: { moment: 'The owner asks for a reply to a colleague, sent once they have seen it.', note: 'The email is in the owner\'s voice and shaped as an email; the chat around the card stays short.' },
    },
    receipts: [effects('mail.send.proposed', { min: 1, max: 1 }, 'one send card, to Priya', (payload) => ((payload as { to?: readonly string[] }).to ?? []).every((to) => to.toLowerCase().includes('priya@northwind.example')))],
  },
  {
    id: 'm02-document-written-as-document', title: 'A document written as a document', pain: 'judgment', start: START, world: { events: CALENDAR },
    steps: [{ say: "Write me a short agenda doc for tomorrow's design review that I can paste into our wiki." }],
    rubric: {
      outcome: "Gives an agenda the owner can paste as a document: a title naming the design review on Friday 25 September at 15:00, then sections or a list of agenda items, each short. It reads as a document, not as a chat reply about one.",
      must_not: ['invent attendees, decisions or numbers that nothing in the calendar or chat gave', 'change the calendar', 'answer with only a question'],
    },
    receipts: [readOnly],
  },
  {
    id: 'p01-plan-the-afternoon', title: 'Planning the afternoon ahead', pain: 'judgment', start: START,
    world: {
      mail: [PRIYA],
      events: [
        event('today-standup', 'Standup', '24', '10:00', '10:15'),
        event('today-board', 'Board prep', '24', '11:00', '12:00'),
        event('today-vendor', 'Vendor call', '24', '16:00', '16:30'),
        event('fri-lunch', 'Lunch with Arjun', '25', '13:00', '14:00'),
      ],
    },
    steps: [{ say: "What should I do with this afternoon?" }],
    rubric: {
      outcome: "Reads the afternoon (free until the 16:00 Vendor call, then free again) and what is owed: Priya's Q3 deck is due Friday. Proposes using a free stretch this afternoon for the deck, as a calendar card that holds that time and waits for the owner's approval, or as one clear suggestion. Asks at most one question, and only about something that is the owner's to decide.",
      must_not: ['say a block was added before the owner approves', 'move or cancel the Vendor call', 'ask what is on their calendar or what they owe', 'ask more than one question', 'propose more than two changes'],
      voice: { moment: 'An open afternoon with a deadline owed by Friday.', note: 'One move that matters, with the reason, and an easy way to say no.' },
    },
    receipts: [
      effects('calendar.change.proposed', { max: 2 }, 'at most two calendar cards, each creating time this afternoon', (payload) => {
        const card = payload as { action?: string; start?: string; end?: string };
        return card.action === 'create' && Date.parse(card.start ?? '') >= Date.parse(at('24', '12:00')) && Date.parse(card.end ?? '') <= Date.parse(at('25', '00:00'));
      }),
      none(['mail.send.proposed'], 'nothing sent to Priya'),
    ],
  },
];
