import { Clock3, Pause, Play, Square } from 'lucide-react';
import type { Action, Settings, Task } from '../shared/types';
export function TaskActions({
  task,
  busy,
  settings,
  onAction,
  onSchedule,
}: {
  task: Task;
  busy: boolean;
  settings: Settings;
  onAction: (action: Action) => void;
  onSchedule: () => void;
}) {
  const active = task.status === 'running' || task.status === 'queued';
  return (
    <div className="task-controls">
      {active ? (
        <button disabled={busy} onClick={() => onAction('pause')}>
          <Pause size={14} />
          Pause task
        </button>
      ) : (
        <button
          disabled={busy || settings.paused || !settings.researchAllowed}
          onClick={() => onAction('run')}
        >
          <Play size={14} />
          {task.status === 'failed'
            ? 'Retry task'
            : task.status === 'paused'
              ? 'Resume task'
              : 'Run again'}
        </button>
      )}
      {task.status === 'completed' && !!task.intervalSeconds && (
        <button disabled={busy} onClick={() => onAction('pause')}>
          <Pause size={14} />
          Pause schedule
        </button>
      )}
      <button onClick={onSchedule}>
        <Clock3 size={14} />
        {task.intervalSeconds ? 'Edit schedule' : 'Set a schedule'}
      </button>
      {task.status !== 'cancelled' && (
        <button
          disabled={busy}
          className="quiet-button"
          onClick={() => onAction('cancel')}
        >
          <Square size={12} />
          Cancel
        </button>
      )}
    </div>
  );
}
