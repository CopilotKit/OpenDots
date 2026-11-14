import { Clock3, Pause, Play, Square } from 'lucide-react';
import type { Action, Settings, Task } from '../shared/types';
import { t } from './i18n';
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
          {t('Pause task')}
        </button>
      ) : (
        <button
          disabled={busy || settings.paused || !settings.researchAllowed}
          onClick={() => onAction('run')}
        >
          <Play size={14} />
          {task.status === 'interrupted'
            ? t('Retry after review')
            : task.status === 'failed'
              ? t('Retry task')
              : task.status === 'paused'
                ? t('Resume task')
                : t('Run again')}
        </button>
      )}
      {task.status === 'completed' && !!task.intervalSeconds && (
        <button disabled={busy} onClick={() => onAction('pause')}>
          <Pause size={14} />
          {t('Pause schedule')}
        </button>
      )}
      <button onClick={onSchedule}>
        <Clock3 size={14} />
        {task.intervalSeconds ? t('Edit schedule') : t('Set a schedule')}
      </button>
      {task.status !== 'cancelled' && (
        <button
          disabled={busy}
          className="quiet-button"
          onClick={() => onAction('cancel')}
        >
          <Square size={12} />
          {t('Cancel')}
        </button>
      )}
    </div>
  );
}
