// WALDO_FILE_TOOLS: an upload the model cannot read is kept in the owner's workspace, and the model chooses the file tools
// to open it. The control asks something no file answers, so a good turn uses no file tool.
import { readOnly, toolWorked, type Receipt } from './receipts';
import { CALENDAR, START, type NightlyScenario } from './scenarios';

export const FILE_TOOLS: readonly string[] = ['workspace_list', 'workspace_read', 'workspace_search', 'extract_archive'];
const noFileTool: Receipt = { why: 'no file tool was called for a question no file answers', holds: (trial) => trial.tools.every((tool) => !FILE_TOOLS.includes(tool.name)) };

export const FILE_SCENARIOS: readonly NightlyScenario[] = [
  {
    id: 'f1-whats-in-this-zip', title: 'What is in this zip', pain: 'follow_through', start: START, world: { files: true },
    steps: [{ say: "What's in this zip?", upload: { filename: 'offsite.zip', mime: 'application/zip', zip: {
      'agenda.md': '# Offsite agenda\n- 10:00 Roadmap review\n- 14:00 Hiring plan\n- 16:30 Team dinner at Olive',
      'budget.csv': 'item,amount_inr\nvenue,85000\ndinner,42000\ntravel,61000',
    } } }],
    rubric: {
      outcome: 'Says the zip holds an agenda and a budget, and gives what they contain: the roadmap review at 10:00, the hiring plan at 14:00 and dinner at Olive at 16:30; venue, dinner and travel lines totalling INR 188,000 or each line named.',
      must_not: ['say the file cannot be read or opened', 'invent a file, time or amount that is not in the zip'],
    },
    receipts: [toolWorked(['extract_archive'], 'it unpacked the archive before answering')],
  },
  {
    id: 'f2-next-meeting-no-files', title: 'Next meeting (file tools control)', pain: 'judgment', start: START, world: { files: true, events: CALENDAR },
    steps: [{ say: 'What time is my next meeting?' }],
    rubric: { outcome: 'Standup at 10:00 today (Thursday 24 September).', must_not: ['name a meeting that is not on the calendar'] },
    receipts: [readOnly, noFileTool],
  },
];
