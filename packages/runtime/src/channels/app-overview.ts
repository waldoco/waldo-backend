import { APP_OVERVIEW_PAGE_MAX_V1, appControlProjectionV1Schema } from '../../../contracts/src/app/controls';
import { loopBook } from './loops';
import { responsibilityBook, type TodoItem } from './responsibilities';

type Sql = Pick<SqlStorage, 'exec'>;
// The books create their tables when missing, but this read never writes a row, so it never draws an id.
const reading = { newId: (): string => { throw new Error('open work is read only'); }, now: Date.now };
const CARRIED = ['open', 'waiting', 'uncertain'] as const;
const FINISHED: readonly TodoItem['status'][] = ['done', 'failed', 'cancelled'];

// The first unfinished step whose prerequisites are done. The owner holds their own steps; any other holder is Waldo or
// one of its workers.
const nextStep = (items: readonly TodoItem[]) => {
  const status = new Map(items.map(item => [item.id, item.status]));
  const step = items.find(item => !FINISHED.includes(item.status) && item.depends_on.every(dep => status.get(dep) === 'done'));
  return step ? { title: step.title, holder: step.owner === 'owner' ? 'owner' as const : 'waldo' as const } : null;
};

const openWork = (sql: Sql) => {
  const responsibilities = responsibilityBook(sql, reading);
  const carried = CARRIED.flatMap(status => responsibilities.list(status)).sort((a, b) =>
    Number(a.next_check_at === null) - Number(b.next_check_at === null) || (a.next_check_at ?? '').localeCompare(b.next_check_at ?? '') || a.created_at - b.created_at);
  const loops = loopBook(sql, reading).list('open');
  return {
    carrying: {
      items: carried.slice(0, APP_OVERVIEW_PAGE_MAX_V1).map(work => ({ id: work.id, title: work.title, state: work.status, next: nextStep(responsibilities.items(work.id)), check_at: work.next_check_at })),
      total: carried.length,
    },
    open_loops: {
      items: loops.slice(0, APP_OVERVIEW_PAGE_MAX_V1).map(loop => ({ id: loop.id, title: loop.title, due: loop.due, source: loop.source_ref ? 'gmail' : 'chat' })),
      total: loops.length,
    },
  };
};

// Open work rides beside the day and never costs it: a read that fails, or a page the contract cannot show, leaves the
// day as it was.
export const withOpenWork = (projection: Record<string, unknown>, sql: Sql): Record<string, unknown> => {
  try {
    const extended = { ...projection, data: { ...(projection.data as object), ...openWork(sql) } };
    if (appControlProjectionV1Schema.safeParse(extended).success) return extended;
    console.error(JSON.stringify({ hop: 'app_open_work', ok: false, code: 'shape' }));
  } catch {
    console.error(JSON.stringify({ hop: 'app_open_work', ok: false, code: 'read_failed' }));
  }
  return projection;
};
