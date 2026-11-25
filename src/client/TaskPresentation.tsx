import {
  CheckCheck,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
} from 'lucide-react';
import type { Task } from '../shared/types';
import { Mascot } from './Mascot';
import { dateLocale, t } from './i18n';
export const relative = (value: number) => {
  const minutes = Math.floor((Date.now() - value) / 60000);
  return minutes < 1
    ? t('Just now')
    : minutes < 60
      ? t('{count}m ago', { count: minutes })
      : minutes < 1440
        ? t('{count}h ago', { count: Math.floor(minutes / 60) })
        : new Date(value).toLocaleDateString(dateLocale);
};
export const statusLabel = (task: Task) =>
  task.status === 'completed' && task.nextRunAt
    ? t('Scheduled')
    : t(task.status.charAt(0).toUpperCase() + task.status.slice(1));
export function Status({ task }: { task: Task }) {
  return (
    <span className={`status ${task.status}`}>
      <span />
      {statusLabel(task)}
    </span>
  );
}

export function TaskRow({
  task,
  onClick,
}: {
  task: Task;
  onClick: () => void;
}) {
  return (
    <button className="task-row" onClick={onClick}>
      <span className="task-row-icon">
        {task.status === 'completed' ? (
          <CheckCheck size={19} />
        ) : task.status === 'running' ? (
          <LoaderCircle className="spin" size={19} />
        ) : (
          <MessageCircle size={19} />
        )}
      </span>
      <div>
        <strong>{task.prompt}</strong>
        <span>
          {task.intervalSeconds
            ? `${t('Repeats every {interval}', {
                interval:
                  task.intervalSeconds < 3600
                    ? t('{count} min', { count: task.intervalSeconds / 60 })
                    : t('{count} hr', { count: task.intervalSeconds / 3600 }),
              })} · `
            : ''}
          {relative(task.updatedAt)}
        </span>
      </div>
      <Status task={task} />
      <ChevronRight size={16} />
    </button>
  );
}
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="large-empty">
      <Mascot />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
