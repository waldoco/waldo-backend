import type {ToolName} from '@waldo/contracts';
// Additive reviewed admission. Gmail and Calendar effects enter their existing approval desks.
const PRIVATE_TOOLS:readonly ToolName[]=['get_context','read_owner_context','workspace_list','workspace_read','workspace_search','workspace_write','workspace_render','skills_list','skills_load'];
const REMINDERS:readonly ToolName[]=['set_reminder','cancel_reminder','list_reminders'];
const GOOGLE_TOOLS:readonly ToolName[]=['query_calendar','propose_calendar_change','query_availability','get_tasks','get_communication','search_communication','read_thread','draft_email','send_email','connect_service'];
export const commonOwnerTools=(options:Readonly<{googleConnected:boolean;driveReads:boolean;publicSearch:boolean;browser:boolean}>):readonly ToolName[]=>[
 ...PRIVATE_TOOLS,...REMINDERS,...(options.googleConnected?GOOGLE_TOOLS:[]),...(options.googleConnected&&options.driveReads?['read_drive' as const]:[]),...(options.publicSearch?['web_search' as const]:[]),...(options.browser?['browse_page' as const]:[]),
];
