import type { Dot } from '../shared/types.js';
import type { TeamBoard } from '../shared/team-board.js';

export function resolveSpecialist(value: string, dots: Dot[]): string {
  const exact = dots.find((dot) => dot.id === value.trim());
  if (exact) return exact.id;
  const name = value
    .trim()
    .replace(/^the\s+/i, '')
    .toLowerCase();
  const matches = dots.filter((dot) => dot.name.toLowerCase() === name);
  if (matches.length === 1) return matches[0].id;
  throw new Error(
    matches.length
      ? `Several Dots are named "${value}". Use an ID from list_specialists.`
      : `No specialist named "${value}". Use list_specialists to choose an existing Dot.`,
  );
}

export function resolveBoardId(
  boards: TeamBoard[],
  threadId: string,
  dotId: string,
  id?: string,
): string {
  if (id?.trim()) return id.trim();
  const participating = boards.find(
    (board) => board.threads[dotId] === threadId,
  );
  if (participating) return participating.id;
  const owned = boards.filter((board) => board.originThreadId === threadId);
  if (owned.length) return owned[0].id; // store.list is newest first
  throw new Error(
    'No team board is linked to this conversation. No workflow has been started here. Supply an explicit ID only when inspecting another board; do not assume an older board is this task.',
  );
}

export function teamStatus(board: TeamBoard) {
  return {
    running: board.status === 'running',
    statusMeaning: {
      running:
        'The scheduler is active; individual steps still need execution and verification.',
      blocked:
        'Execution has stopped because of an error or unresolved blocker. No specialists are running on this board.',
      stopped:
        'Execution was stopped. No specialists are running on this board.',
      completed: 'All assigned workflow steps were accepted by the manager.',
      decided:
        'The discussion finished; a decision is recorded. This does not prove proposed actions were executed.',
      awaiting_review:
        'A tested code change awaits owner review. It has not been applied by this board.',
    }[board.status],
  };
}
