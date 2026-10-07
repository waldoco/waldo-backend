import type {ToolName} from '@waldo/contracts';
// Additive reviewed admission. Effects (including artifact relays) stay held until
// their canonical approval/delivery path is registered; no blanket handler import.
const PRIVATE_TOOLS:readonly ToolName[]=['get_context','read_owner_context','workspace_list','workspace_read','workspace_search','workspace_write','workspace_render','skills_list','skills_load'];
const REMINDERS:readonly ToolName[]=['set_reminder','cancel_reminder','list_reminders'];
const GOOGLE_READS:readonly ToolName[]=['query_calendar','query_availability','get_tasks','get_communication','read_thread','search_communication'];
export const commonOwnerTools=(options:Readonly<{googleConnected:boolean;driveReads:boolean;publicSearch:boolean;browser:boolean}>):readonly ToolName[]=>[
 ...PRIVATE_TOOLS,...REMINDERS,...(options.googleConnected?GOOGLE_READS:[]),...(options.googleConnected&&options.driveReads?['read_drive' as const]:[]),...(options.publicSearch?['web_search' as const]:[]),...(options.browser?['browse_page' as const]:[]),
];
