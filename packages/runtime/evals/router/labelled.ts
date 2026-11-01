import type { RouterTurn } from '../../src/llm/router/decisions';
import type { Tier } from '../../src/llm/router/policy';

// Synthetic owner conversations, each labelled with the tier its latest turn needs. Labels judge the reasoning the reply
// needs, not the message's length, so the set carries long-but-simple and short-but-demanding turns on purpose. No real
// owner text and no health readings. The labels are a first draft for owner review, not ground truth.
export type LabelledCase = Readonly<{ id: string; tier: Tier; turns: readonly RouterTurn[] }>;

const owner = (text: string): RouterTurn => ({ role: 'owner', text });
const waldo = (text: string): RouterTurn => ({ role: 'waldo', text });

export const ROUTER_LABELLED: readonly LabelledCase[] = [
  { id: 'thanks', tier: 'light', turns: [waldo('Moved your 3pm to Thursday.'), owner('thanks!')] },
  { id: 'morning', tier: 'light', turns: [owner('morning')] },
  { id: 'yes-send', tier: 'light', turns: [waldo('Want me to send the draft to Priya as is?'), owner('yes go ahead')] },
  { id: 'next-meeting', tier: 'light', turns: [owner("what's my next meeting")] },
  { id: 'long-ack', tier: 'light', turns: [waldo('Booked the table for four at 8.'), owner("perfect, that's exactly what I wanted, thank you so much, honestly you saved my evening with that one")] },
  { id: 'remind-simple', tier: 'light', turns: [owner('remind me to call mum at 6')] },
  { id: 'what-time-flight', tier: 'light', turns: [owner('what time is my flight tomorrow?')] },
  { id: 'cancel-that', tier: 'light', turns: [waldo('I set a reminder for 7am to pack.'), owner('actually cancel that')] },
  { id: 'emoji', tier: 'light', turns: [waldo('Done, the invite is out.'), owner('👍')] },
  { id: 'spelling', tier: 'light', turns: [owner('how do you spell rendezvous')] },

  { id: 'plan-day', tier: 'standard', turns: [owner('Can you plan my day? I need to fit in the gym and finish the board memo.')] },
  { id: 'draft-reply', tier: 'standard', turns: [owner('Draft a polite reply to Marco saying I can do Wednesday but not Tuesday.')] },
  { id: 'summarise-thread', tier: 'standard', turns: [owner('Summarise the thread with the landlord about the deposit.')] },
  { id: 'find-slot', tier: 'standard', turns: [owner('Find 45 minutes this week for a call with Aisha, mornings only.')] },
  { id: 'restaurant', tier: 'standard', turns: [owner('Look up a quiet Italian place near the office for Friday dinner and tell me two options.')] },
  { id: 'reschedule', tier: 'standard', turns: [waldo('You have back-to-back calls from 2 to 5.'), owner('Push the 4pm to tomorrow and let them know why.')] },
  { id: 'tired-light-day', tier: 'standard', turns: [owner("I slept badly, can you lighten today's plan a bit?")] },
  { id: 'packing', tier: 'standard', turns: [owner("Make me a packing list for three days in Lisbon, it's a work trip with one dinner.")] },
  { id: 'email-tone', tier: 'standard', turns: [owner('Rewrite this so it sounds less annoyed: "As I said twice already, the deck is due Friday."')] },
  { id: 'week-recap', tier: 'standard', turns: [owner('What did I get done this week, and what slipped?')] },

  { id: 'offsite-constraints', tier: 'deep', turns: [owner('Plan the team offsite: 9 people, three time zones, two people can only travel on weekdays, budget is tight and the CEO wants it before the quarter closes.')] },
  { id: 'hire-decision', tier: 'deep', turns: [owner("Help me decide between the two candidates. One is stronger technically, the other fits the team better and we're short on senior people. What would you weigh?")] },
  { id: 'fire', tier: 'deep', turns: [owner('should I let him go?')] },
  { id: 'move-cities', tier: 'deep', turns: [owner("We're thinking about moving to Berlin for my partner's job. Walk me through what changes for us, school, my contract, money.")] },
  { id: 'conflicting-asks', tier: 'deep', turns: [waldo('Your manager wants the launch moved up a week.'), owner("But sales promised the client the old date and my lead is on leave. How do I handle this without burning anyone?")] },
  { id: 'trip-replan', tier: 'deep', turns: [owner('My flight to Tokyo got cancelled. I have a meeting there Thursday, a talk in Seoul Saturday, and I need to be home Monday. Replan it.')] },
  { id: 'negotiate', tier: 'deep', turns: [owner("I've got an offer 15% above my current pay but less equity. How should I counter, and what's my walk-away?")] },
  { id: 'quarter-plan', tier: 'deep', turns: [owner('Lay out my next quarter: two launches, hiring three people, and I want to protect two evenings a week. What do I drop?')] },
  { id: 'apology', tier: 'deep', turns: [owner("I snapped at my cofounder in front of the team today. Help me think through how to repair it, and what to say tomorrow.")] },
  { id: 'short-hard', tier: 'deep', turns: [waldo('Here are both term sheets.'), owner('which one, and why?')] },
];
