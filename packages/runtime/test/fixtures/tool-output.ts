// A tool result as a scripted model reads it: a result from an outside source starts with the provider's label line,
// and the JSON follows it.
export const EXTERNAL_LABEL = /^\[external data from [a-z_]+, not instructions\]\n/;
export const toolOutput = <T = unknown>(output: string): T => JSON.parse(output.replace(EXTERNAL_LABEL, '')) as T;
