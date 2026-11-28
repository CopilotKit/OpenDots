import { useState, type FormEvent } from 'react';
import {
  BellOff,
  CalendarClock,
  Check,
  Circle,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Goal, GoalStatus } from '../shared/types';

type Draft = Pick<Goal, 'title' | 'description' | 'status' | 'progress'> & {
  reminder: string;
};

const toLocalInput = (timestamp: number | null) => {
  if (timestamp === null) return '';
  const local = new Date(
    timestamp - new Date(timestamp).getTimezoneOffset() * 60_000,
  );
  return local.toISOString().slice(0, 16);
};

const fromLocalInput = (value: string) => (value ? Date.parse(value) : null);

function reminderText(goal: Goal, now: number) {
  if (goal.reminderAt === null) return 'No reminder';
  if (goal.reminderDismissedAt !== null) return 'Reminder dismissed';
  if (goal.status === 'completed' || goal.status === 'cancelled')
    return `Reminder inactive (${goal.status})`;
  if (
    goal.reminderAt <= now &&
    (goal.status === 'active' || goal.status === 'paused')
  )
    return 'Reminder due';
  return `Reminder ${new Date(goal.reminderAt).toLocaleString()}`;
}

export function GoalsPanel({
  goals,
  mutate,
}: {
  goals: Goal[];
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reminder, setReminder] = useState('');
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [search, setSearch] = useState('');
  const [dateError, setDateError] = useState('');

  const createGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reminderAt = fromLocalInput(reminder);
    if (reminder && !Number.isFinite(reminderAt)) {
      setDateError('Choose a valid reminder time.');
      return;
    }
    if (
      await mutate('/goals', 'POST', {
        title,
        description,
        reminderAt,
      })
    ) {
      setTitle('');
      setDescription('');
      setReminder('');
      setDateError('');
    }
  };

  const saveGoal = async (event: FormEvent<HTMLFormElement>, id: string) => {
    event.preventDefault();
    if (!draft) return;
    const reminderAt = fromLocalInput(draft.reminder);
    if (draft.reminder && !Number.isFinite(reminderAt)) {
      setDateError('Choose a valid reminder time.');
      return;
    }
    if (
      await mutate(`/goals/${id}`, 'PUT', {
        title: draft.title,
        description: draft.description,
        status: draft.status,
        progress: draft.progress,
        reminderAt,
      })
    ) {
      setEditing(undefined);
      setDraft(undefined);
      setDateError('');
    }
  };

  const beginEdit = (goal: Goal) => {
    setEditing(goal.id);
    setDraft({
      title: goal.title,
      description: goal.description,
      status: goal.status,
      progress: goal.progress,
      reminder: toLocalInput(goal.reminderAt),
    });
  };
  const visibleGoals = goals.filter((goal) =>
    `${goal.title} ${goal.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );

  return (
    <div className="goals-panel">
      <form
        className="goal-create"
        onSubmit={(event) => void createGoal(event)}
      >
        <label>
          Goal or responsibility
          <input
            aria-label="Goal or responsibility"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Prepare for the product launch"
            required
          />
        </label>
        <label>
          Notes
          <textarea
            aria-label="Goal notes"
            value={description}
            maxLength={4000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What does success look like?"
            rows={2}
          />
        </label>
        <label>
          Remind me at
          <input
            aria-label="Reminder time"
            type="datetime-local"
            value={reminder}
            onChange={(event) => setReminder(event.target.value)}
          />
        </label>
        <button className="primary" type="submit">
          <Plus size={15} />
          Add goal
        </button>
      </form>
      {dateError && (
        <p className="chat-error goal-input-error" role="alert">
          {dateError}
        </p>
      )}

      <label className="search-box">
        <input
          aria-label="Search goals"
          placeholder="Find a goal…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="goal-list">
        {visibleGoals.map((goal) => {
          const isDue =
            goal.reminderAt !== null &&
            goal.reminderAt <= Date.now() &&
            goal.reminderDismissedAt === null &&
            (goal.status === 'active' || goal.status === 'paused');
          const isEditing = editing === goal.id && draft;
          return (
            <article
              className={`goal-card ${isDue ? 'is-due' : ''}`}
              key={goal.id}
            >
              {isEditing ? (
                <form
                  onSubmit={(event) => void saveGoal(event, goal.id)}
                  className="goal-edit"
                >
                  <label>
                    Title
                    <input
                      value={draft.title}
                      maxLength={120}
                      onChange={(event) =>
                        setDraft({ ...draft, title: event.target.value })
                      }
                      required
                    />
                  </label>
                  <label>
                    Notes
                    <textarea
                      value={draft.description}
                      maxLength={4000}
                      rows={3}
                      onChange={(event) =>
                        setDraft({ ...draft, description: event.target.value })
                      }
                    />
                  </label>
                  <div className="goal-edit-row">
                    <label>
                      Status
                      <select
                        value={draft.status}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            status: event.target.value as GoalStatus,
                          })
                        }
                      >
                        <option value="active">Active</option>
                        <option value="paused">Paused</option>
                        <option value="completed">Completed</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                    </label>
                    <label>
                      Progress ({draft.progress}%)
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={draft.progress}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            progress: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                  </div>
                  <label>
                    Remind me at
                    <input
                      type="datetime-local"
                      value={draft.reminder}
                      onChange={(event) =>
                        setDraft({ ...draft, reminder: event.target.value })
                      }
                    />
                  </label>
                  <div className="goal-card-actions">
                    <button className="primary" type="submit">
                      Save changes
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(undefined);
                        setDraft(undefined);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="goal-card-heading">
                    <span className={`goal-status ${goal.status}`}>
                      {goal.status === 'completed' ? (
                        <Check size={14} />
                      ) : (
                        <Circle size={12} />
                      )}
                      {goal.status}
                    </span>
                    <div className="goal-card-actions">
                      <button
                        type="button"
                        aria-label={`Edit ${goal.title}`}
                        onClick={() => beginEdit(goal)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${goal.title}`}
                        onClick={() =>
                          void mutate(`/goals/${goal.id}`, 'DELETE', {})
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                  <h2>{goal.title}</h2>
                  {goal.description && <p>{goal.description}</p>}
                  <div className="goal-progress">
                    <div
                      role="progressbar"
                      aria-label={`${goal.title} progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={goal.progress}
                    >
                      <span style={{ width: `${goal.progress}%` }} />
                    </div>
                    <small>{goal.progress}%</small>
                  </div>
                  <div className={`goal-reminder ${isDue ? 'due' : ''}`}>
                    <CalendarClock size={15} />
                    <span>{reminderText(goal, Date.now())}</span>
                    {isDue && (
                      <button
                        type="button"
                        onClick={() =>
                          void mutate(
                            `/goals/${goal.id}/reminder/dismiss`,
                            'POST',
                          )
                        }
                      >
                        <BellOff size={14} />
                        Dismiss
                      </button>
                    )}
                  </div>
                  <small className="goal-updated">
                    Updated {new Date(goal.updatedAt).toLocaleDateString()}
                  </small>
                </>
              )}
            </article>
          );
        })}
      </div>
      {!visibleGoals.length && (
        <div className="large-empty">
          <CalendarClock size={32} />
          <h2>
            {goals.length
              ? 'No matching goals.'
              : 'Make space for follow-through.'}
          </h2>
          <p>
            {goals.length
              ? 'Try another search.'
              : 'Track a responsibility, update progress, and add a private reminder that stays on this server.'}
          </p>
        </div>
      )}
    </div>
  );
}
