import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { DotLearning } from './DotLearning';
import { ConfirmationControl } from './ConfirmationControl';
import type { Dot, Memory, State, WorkspaceState } from '../shared/types';
import {
  allToolGroups,
  defaultToolGroups,
  toolGroups,
} from '../shared/capabilities';
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export type Dialog =
  | { type: 'space' }
  | { type: 'dot'; dot?: Dot; spaceId: string }
  | { type: 'settings' }
  | { type: 'memory'; memory?: Memory }
  | { type: 'schedule'; threadId: string };
export function WorkspaceDialog({
  dialog,
  state,
  workspace,
  onClose,
  mutate,
}: {
  dialog: Dialog;
  state: State;
  workspace: WorkspaceState;
  onClose: () => void;
  mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState(
    dialog.type === 'dot' ? (dialog.dot?.name ?? '') : '',
  );
  const [text, setText] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.instructions ?? '')
      : dialog.type === 'memory'
        ? (dialog.memory?.text ?? '')
        : '',
  );
  const [research, setResearch] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.researchAllowed ?? true)
      : state.settings.researchAllowed,
  );
  const [memory, setMemory] = useState(
    dialog.type === 'dot'
      ? (dialog.dot?.memoryAllowed ?? true)
      : state.settings.memoryAllowed,
  );
  const [spaceIds, setSpaceIds] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceIds ?? [dialog.spaceId]) : [],
  );
  const [defaultSpace, setDefaultSpace] = useState(
    dialog.type === 'dot' ? (dialog.dot?.spaceId ?? dialog.spaceId) : '',
  );
  const [interval, setInterval] = useState('86400');
  // Cloud Learning is unavailable locally; preserve stored values unchanged.
  const learningContainer =
    dialog.type === 'dot' ? (dialog.dot?.learningContainerId ?? '') : '';
  const skillDelivery =
    dialog.type === 'dot' ? (dialog.dot?.skillDeliveryEnabled ?? false) : false;
  const [model, setModel] = useState(
    dialog.type === 'dot' ? (dialog.dot?.model ?? '@default') : '@default',
  );
  const [thinking, setThinking] = useState(
    dialog.type === 'dot' ? (dialog.dot?.thinking ?? true) : true,
  );
  const [groups, setGroups] = useState<string[]>(
    dialog.type === 'dot'
      ? (dialog.dot?.toolGroups ?? defaultToolGroups)
      : defaultToolGroups,
  );
  const [models, setModels] = useState({
    defaultModel: workspace.models?.defaultModel ?? '',
    plannerModel: workspace.models?.plannerModel ?? '',
    visionModel: workspace.models?.visionModel ?? '',
  });
  const [triggerType, setTriggerType] = useState<'interval' | 'daily' | 'file'>(
    'interval',
  );
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [folder, setFolder] = useState('');
  const [pattern, setPattern] = useState('*');
  const available = workspace.models?.available ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    container.current
      ?.querySelector<HTMLElement>('input,textarea,select')
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(container.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input,textarea,select,a[href]',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  const title =
    dialog.type === 'space'
      ? 'A space for something.'
      : dialog.type === 'dot'
        ? dialog.dot
          ? 'Make this Dot yours.'
          : 'Meet your next specialist.'
        : dialog.type === 'settings'
          ? 'Your workspace, your rules.'
          : dialog.type === 'memory'
            ? 'Something to remember.'
            : 'Let your Dot keep time.';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={container}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">OPENDOTS TEMPLATE</span>
        <h2 id="dialog-title">{title}</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            let path = '',
              method = 'POST',
              body: unknown;
            if (dialog.type === 'space') {
              path = '/spaces';
              body = { name, description: text };
            }
            if (dialog.type === 'dot') {
              path = dialog.dot ? `/dots/${dialog.dot.id}` : '/dots';
              method = dialog.dot ? 'PUT' : 'POST';
              body = {
                spaceId: defaultSpace,
                spaceIds,
                name,
                instructions: text,
                researchAllowed: research,
                memoryAllowed: memory,
                learningContainerId: learningContainer.trim() || null,
                skillDeliveryEnabled: skillDelivery,
                model,
                toolGroups: groups,
                thinking,
              };
            }
            if (dialog.type === 'settings') {
              path = '/settings';
              method = 'PATCH';
              body = { researchAllowed: research, memoryAllowed: memory };
            }
            if (dialog.type === 'memory') {
              path = dialog.memory
                ? `/memories/${dialog.memory.id}`
                : '/memories';
              method = dialog.memory ? 'PUT' : 'POST';
              body = { text };
            }
            if (dialog.type === 'schedule') {
              path = '/tasks';
              body = {
                prompt: text,
                threadId: dialog.threadId,
                ...(triggerType === 'interval'
                  ? { intervalSeconds: Number(interval) }
                  : {
                      trigger:
                        triggerType === 'daily'
                          ? { type: 'daily', time, days }
                          : { type: 'file', folder, pattern },
                    }),
              };
            }
            if (
              dialog.type === 'settings' &&
              !(await mutate('/models', 'PATCH', models))
            ) {
              setError('Could not save model settings.');
              setBusy(false);
              return;
            }
            if (await mutate(path, method, body)) onClose();
            else
              setError('Could not save. Review the workspace error and retry.');
            setBusy(false);
          }}
        >
          {(dialog.type === 'space' || dialog.type === 'dot') && (
            <>
              <label className="field-label" htmlFor="entity-name">
                Name
              </label>
              <input
                id="entity-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </>
          )}
          {dialog.type !== 'settings' && (
            <>
              <label className="field-label" htmlFor="entity-text">
                {dialog.type === 'dot'
                  ? 'Role instructions'
                  : dialog.type === 'space'
                    ? 'What belongs here?'
                    : dialog.type === 'memory'
                      ? 'Preference or context'
                      : 'Task to revisit'}
              </label>
              <textarea
                id="entity-text"
                rows={4}
                maxLength={dialog.type === 'schedule' ? 4000 : 2000}
                required={dialog.type !== 'space'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  dialog.type === 'dot'
                    ? 'You are a thoughtful research partner. Compare evidence and be clear about uncertainty.'
                    : ''
                }
              />
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Space access</legend>
              <p className="muted">
                Choose where this Dot can read and edit pages.
              </p>
              {workspace.spaces.map((space) => (
                <label className="permission-row" key={space.id}>
                  <input
                    type="checkbox"
                    checked={spaceIds.includes(space.id)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...spaceIds, space.id]
                        : spaceIds.filter((id) => id !== space.id);
                      setSpaceIds(next);
                      if (!next.includes(defaultSpace))
                        setDefaultSpace(next[0] ?? '');
                    }}
                  />
                  <span>{space.name}</span>
                </label>
              ))}
              <label className="field-label" htmlFor="default-space">
                Default destination for saved pages
              </label>
              <select
                id="default-space"
                value={defaultSpace}
                required
                onChange={(event) => setDefaultSpace(event.target.value)}
              >
                <option value="" disabled>
                  Choose a Space
                </option>
                {workspace.spaces
                  .filter((space) => spaceIds.includes(space.id))
                  .map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
              </select>
            </fieldset>
          )}
          {dialog.type === 'settings' && (
            <fieldset className="space-access-fields">
              <legend>Local models</legend>
              <p className="muted">
                Dots set to a role follow these choices. Installed in Ollama:{' '}
                {available.join(', ') || 'none found'}.
              </p>
              {(
                [
                  ['defaultModel', 'Default (heavier, main work)'],
                  ['plannerModel', 'Planner (light, routing and planning)'],
                  ['visionModel', 'Vision (image reading)'],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <label className="field-label" htmlFor={`model-${key}`}>
                    {label}
                  </label>
                  <select
                    id={`model-${key}`}
                    value={models[key]}
                    onChange={(e) =>
                      setModels({ ...models, [key]: e.target.value })
                    }
                  >
                    {[...new Set([models[key], ...available])]
                      .filter(Boolean)
                      .map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                  </select>
                </div>
              ))}
            </fieldset>
          )}
          {(dialog.type === 'dot' || dialog.type === 'settings') && (
            <>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => setResearch(e.target.checked)}
                />
                <span>
                  <strong>Public-page research</strong>
                  <small>
                    Allow the server-side read-only browser tool. Global
                    settings always take precedence.
                  </small>
                </span>
              </label>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={memory}
                  onChange={(e) => setMemory(e.target.checked)}
                />
                <span>
                  <strong>Use saved memories</strong>
                  <small>
                    Include your preferences in new turns. Changing permission
                    stops active work.
                  </small>
                </span>
              </label>
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Model</legend>
              <label className="field-label" htmlFor="dot-model">
                Local model for this Dot
              </label>
              <select
                id="dot-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="@default">
                  Default role ({workspace.models?.defaultModel || 'not set'})
                </option>
                <option value="@planner">
                  Planner role, light ({workspace.models?.plannerModel})
                </option>
                <option value="@vision">
                  Vision role ({workspace.models?.visionModel})
                </option>
                {[...new Set([model, ...available])]
                  .filter((name) => name && !name.startsWith('@'))
                  .map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
              </select>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={thinking}
                  onChange={(e) => setThinking(e.target.checked)}
                />
                <span>
                  <strong>Think before answering</strong>
                  <small>
                    Better for planning and multi-step work; much slower on
                    local models. Turn off for quick, simple jobs.
                  </small>
                </span>
              </label>
            </fieldset>
          )}
          {dialog.type === 'dot' && dialog.dot && (
            <DotLearning dotId={dialog.dot.id} onApplied={setText} />
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>Tools</legend>
              <p className="muted">
                Only granted tools are offered to this Dot. Risky actions still
                ask you first.
              </p>
              {[...allToolGroups, ...(workspace.mcpGroups ?? [])].map(
                (group) => {
                  const info =
                    group in toolGroups
                      ? toolGroups[group as keyof typeof toolGroups]
                      : {
                          label: group.replace(/^mcp:/, ''),
                          description: 'Tools from this MCP server.',
                        };
                  return (
                    <label className="permission-row" key={group}>
                      <input
                        type="checkbox"
                        checked={groups.includes(group)}
                        onChange={(e) =>
                          setGroups(
                            e.target.checked
                              ? [...groups, group]
                              : groups.filter((item) => item !== group),
                          )
                        }
                      />
                      <span>
                        <strong>{info.label}</strong>
                        <small>{info.description}</small>
                      </span>
                    </label>
                  );
                },
              )}
            </fieldset>
          )}
          {dialog.type === 'schedule' && (
            <>
              <label className="field-label" htmlFor="schedule-trigger">
                When should it run?
              </label>
              <select
                id="schedule-trigger"
                value={triggerType}
                onChange={(e) =>
                  setTriggerType(e.target.value as typeof triggerType)
                }
              >
                <option value="interval">
                  Now, then repeat on an interval
                </option>
                <option value="daily">Every day at a time</option>
                <option value="file">
                  When a new file appears in a folder
                </option>
              </select>
            </>
          )}
          {dialog.type === 'schedule' && triggerType === 'daily' && (
            <>
              <label className="field-label" htmlFor="schedule-time">
                Time
              </label>
              <input
                id="schedule-time"
                type="time"
                value={time}
                required
                onChange={(e) => setTime(e.target.value)}
              />
              <div className="weekday-row">
                {weekdays.map((day, index) => (
                  <label className="permission-row" key={day}>
                    <input
                      type="checkbox"
                      checked={days.includes(index)}
                      onChange={(e) =>
                        setDays(
                          e.target.checked
                            ? [...days, index].sort()
                            : days.filter((d) => d !== index),
                        )
                      }
                    />
                    <span>{day}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          {dialog.type === 'schedule' && triggerType === 'file' && (
            <>
              <label className="field-label" htmlFor="schedule-folder">
                Folder to watch
              </label>
              <input
                id="schedule-folder"
                value={folder}
                required
                placeholder="C:\Users\you\Downloads"
                onChange={(e) => setFolder(e.target.value)}
              />
              <label className="field-label" htmlFor="schedule-pattern">
                File name pattern
              </label>
              <input
                id="schedule-pattern"
                value={pattern}
                required
                placeholder="*.pdf"
                onChange={(e) => setPattern(e.target.value)}
              />
              <p className="muted">
                The new file path is added to the task for that run.
              </p>
            </>
          )}
          {dialog.type === 'schedule' && triggerType === 'interval' && (
            <>
              <label className="field-label" htmlFor="schedule-interval">
                Repeat after each successful run
              </label>
              <select
                id="schedule-interval"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="60">Every minute (testing)</option>
                <option value="3600">Every hour</option>
                <option value="86400">Every day</option>
                <option value="604800">Every week</option>
              </select>
              <p className="muted">
                Runs on the server in this same conversation, even with the tab
                closed. Failed runs wait for manual retry.
              </p>
            </>
          )}
          {dialog.type === 'settings' && <ConfirmationControl />}
          {dialog.type === 'settings' && (
            <div className="config-note">
              <strong>Service setup</strong>
              <p>
                {workspace.setup.missing.length
                  ? `Add ${workspace.setup.missing.join(', ')} to the server environment, then restart.`
                  : 'Text configuration is present. A successful conversation confirms connectivity.'}
              </p>
              <p>
                Local-only mode: conversations, memory and tools stay on this
                PC. Slack and cloud voice are disabled.
              </p>
              <a
                href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP.md"
                target="_blank"
                rel="noreferrer"
              >
                Template setup guide ↗
              </a>
            </div>
          )}
          {dialog.type === 'memory' && (
            <p className="muted">
              Memories are explicit preferences, not automatic learning. Avoid
              secrets; enabled memories go to your model provider.
            </p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </form>
      </section>
    </div>
  );
}
