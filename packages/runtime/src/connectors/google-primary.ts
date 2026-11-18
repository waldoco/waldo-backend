// The owner's primary Google account: the one Waldo uses when a read or write names no account. The owner object keeps the
// chosen account's id; with none chosen, or the chosen one gone, the first connected account is primary, as before.
export const GOOGLE_PRIMARY_KEY = 'google:primary';

export const primaryAccountId = (accounts: readonly Readonly<{ id: string }>[], chosen: string | undefined): string | null =>
  (chosen !== undefined && accounts.some(account => account.id === chosen) ? chosen : accounts[0]?.id) ?? null;

// The accounts that can serve a feature, the primary first; the others keep their order behind it.
export const primaryFirst = <T extends Readonly<{ id: string }>>(accounts: readonly T[], chosen: string | undefined): T[] =>
  [...accounts.filter(account => account.id === chosen), ...accounts.filter(account => account.id !== chosen)];
