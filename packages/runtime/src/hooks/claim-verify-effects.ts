import type { ToolName } from '@waldo/contracts';
import { toolRecordColumn } from '../tools/records';

// Which effect a tool's receipt can back in a "done" claim, kept in its tool record. null = the tool has no claimable
// effect (a read, a lookup, or a proposal that changes nothing).
export const TOOL_CLAIM_EFFECT: Readonly<Record<ToolName, string | null>> = toolRecordColumn('claim');
