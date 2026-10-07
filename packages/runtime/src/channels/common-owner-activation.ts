// Global opt-in remains explicit. Optional staging selector limits the existing
// path to one exact physical owner, not a new route or owner authority.
export const commonOwnerActivation=(env:Readonly<{COMMON_OWNER_TASKS?:string;COMMON_OWNER_DO_NAME?:string;WALDO_ENVIRONMENT?:string}>,doName:string|undefined):boolean=>
 env.WALDO_ENVIRONMENT==='staging'&&env.COMMON_OWNER_TASKS==='1'&&!!doName&&(!env.COMMON_OWNER_DO_NAME||env.COMMON_OWNER_DO_NAME===doName);
