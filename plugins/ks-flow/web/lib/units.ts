import type { WorkUnitDoc } from './types';

// Linear statuses treated as "done" → the Done column, whatever phase the unit
// reached.
const DONE_STATUSES = new Set([
  'done',
  'completed',
  'complete',
  'canceled',
  'cancelled',
  'merged',
  'closed',
  'archived',
]);

/** Finished: a done status name, or Linear's completed/canceled state type once synced. */
export const isDone = (u: WorkUnitDoc): boolean =>
  (!!u.linearStatus && DONE_STATUSES.has(u.linearStatus.trim().toLowerCase())) ||
  u.linearStatusType === 'completed' ||
  u.linearStatusType === 'canceled';
