import {
  CheckCheck,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
} from 'lucide-react';
import type { Task } from '../shared/types';
import { Mascot } from './Mascot';
import { t } from './i18n';
export const relative = (value: number) => {
  const minutes = Math.floor((Date.now() - value) / 60000);
  return minutes < 1
    ? t('tasks.now')
    : minutes < 60
      ? `há ${minutes} min`
      : minutes < 1440
        ? `há ${Math.floor(minutes / 60)} h`
        : new Date(value).toLocaleDateString('pt-BR');
};
export const statusLabel = (task: Task) =>
  task.status === 'completed' && task.nextRunAt
    ? t('tasks.scheduled')
    : t(
        `tasks.${task.status}` as
          | 'tasks.queued'
          | 'tasks.running'
          | 'tasks.completed'
          | 'tasks.failed'
          | 'tasks.interrupted'
          | 'tasks.paused'
          | 'tasks.cancelled',
      );
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
            ? `${t('tasks.repeatEvery')} ${task.intervalSeconds < 3600 ? task.intervalSeconds / 60 + ' min' : task.intervalSeconds / 3600 + ' h'} · `
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
