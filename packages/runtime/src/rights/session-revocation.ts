import type { ConsoleAuth } from '../identity/console-auth';
import type { AppPushDirectory } from './push-directory';
import { RightsError } from './jobs';

// The existing directory session is the authority. Push is settled first so a
// successful signout cannot leave a registered native token active on the server.
export const appSessionRevocation = (doName: string, auth: Pick<ConsoleAuth, 'revokeSession' | 'signOutAll' | 'listSessions'>, push: Pick<AppPushDirectory, 'revokeSession' | 'revokeAll'>) => {
  const revokeHash = async (sessionHash: string): Promise<boolean> => {
    if (!/^[a-f0-9]{64}$/.test(sessionHash) || !doName) throw new RightsError('rejected');
    await push.revokeSession(sessionHash);
    // A false mutation may mean an earlier attempt removed the session already.
    // Only fresh signed inventory can establish absence in either case.
    await auth.revokeSession(doName, sessionHash);
    return !(await auth.listSessions(doName)).some(row => row.session === sessionHash);
  };
  return { revokeHash,
  async revokeRef(sessionRef: string): Promise<boolean> {
    if (!/^sess_[a-f0-9]{64}$/.test(sessionRef)) throw new RightsError('rejected');
    return revokeHash(sessionRef.slice(5));
  },
  async revokeAll(): Promise<boolean> {
    if (!doName) throw new RightsError('rejected');
    await push.revokeAll(); await auth.signOutAll(doName);
    return (await auth.listSessions(doName)).length === 0;
  },
  };
};
