import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Dot, Memory, State, WorkspaceState } from '../shared/types';
import { ConnectionsSection } from './ConnectionsSection';
import {
  setThemePreference,
  themePreference,
  type ThemePreference,
} from './theme';
import { t } from './i18n/pt-BR';
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
  const [learningContainer, setLearningContainer] = useState(
    dialog.type === 'dot' ? (dialog.dot?.learningContainerId ?? '') : '',
  );
  const [skillDelivery, setSkillDelivery] = useState(
    dialog.type === 'dot' ? (dialog.dot?.skillDeliveryEnabled ?? false) : false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(themePreference);
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
      ? t('dialogs.newSpace')
      : dialog.type === 'dot'
        ? dialog.dot
          ? t('dialogs.editAgent')
          : t('dialogs.newAgent')
        : dialog.type === 'settings'
          ? t('dialogs.workspaceRules')
          : dialog.type === 'memory'
            ? t('dialogs.memoryTitle')
            : t('dialogs.scheduleTitle');
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
          aria-label={t('dialogs.close')}
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">{t('dialogs.template')}</span>
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
                intervalSeconds: Number(interval),
              };
            }
            if (await mutate(path, method, body)) onClose();
            else setError(t('editor.saveReviewError'));
            setBusy(false);
          }}
        >
          {(dialog.type === 'space' || dialog.type === 'dot') && (
            <>
              <label className="field-label" htmlFor="entity-name">
                {t('dialogs.name')}
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
                  ? t('dialogs.roleInstructions')
                  : dialog.type === 'space'
                    ? t('dialogs.whatBelongs')
                    : dialog.type === 'memory'
                      ? t('dialogs.preferenceContext')
                      : t('dialogs.taskToRevisit')}
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
                    ? t('dialogs.instructionsPlaceholder')
                    : ''
                }
              />
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>{t('dialogs.spaceAccess')}</legend>
              <p className="muted">{t('dialogs.chooseSpaceAccess')}</p>
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
                {t('dialogs.defaultSavedPages')}
              </label>
              <select
                id="default-space"
                value={defaultSpace}
                required
                onChange={(event) => setDefaultSpace(event.target.value)}
              >
                <option value="" disabled>
                  {t('dialogs.chooseSpace')}
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
          {(dialog.type === 'dot' || dialog.type === 'settings') && (
            <>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={research}
                  onChange={(e) => setResearch(e.target.checked)}
                />
                <span>
                  <strong>{t('dialogs.researchHeading')}</strong>
                  <small>{t('dialogs.researchHelp')}</small>
                </span>
              </label>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={memory}
                  onChange={(e) => setMemory(e.target.checked)}
                />
                <span>
                  <strong>{t('dialogs.memoryHeading')}</strong>
                  <small>{t('dialogs.memoryHelp')}</small>
                </span>
              </label>
            </>
          )}
          {dialog.type === 'dot' && (
            <fieldset className="space-access-fields">
              <legend>{t('dialogs.learning')}</legend>
              <label className="field-label" htmlFor="learning-container">
                {t('dialogs.learningContainerId')}
              </label>
              <input
                id="learning-container"
                value={learningContainer}
                maxLength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                placeholder="research-workflow"
                aria-describedby="learning-help"
                onChange={(event) => {
                  setLearningContainer(event.target.value);
                  if (!event.target.value.trim()) setSkillDelivery(false);
                }}
              />
              <p className="muted" id="learning-help">
                {t('dialogs.learningHelp')}
              </p>
              <label className="permission-row">
                <input
                  type="checkbox"
                  checked={skillDelivery}
                  disabled={!learningContainer.trim()}
                  onChange={(event) => setSkillDelivery(event.target.checked)}
                />
                <span>
                  <strong>{t('dialogs.publishedSkills')}</strong>
                  <small>{t('dialogs.publishedSkillsHelp')}</small>
                </span>
              </label>
              <a
                href="https://docs.copilotkit.ai/learning"
                target="_blank"
                rel="noreferrer"
              >
                {t('dialogs.learningGuide')} ↗
              </a>
            </fieldset>
          )}
          {dialog.type === 'dot' && dialog.dot && (
            <ConnectionsSection dotId={dialog.dot.id} />
          )}
          {dialog.type === 'schedule' && (
            <>
              <label className="field-label" htmlFor="schedule-interval">
                {t('dialogs.repeatAfterRun')}
              </label>
              <select
                id="schedule-interval"
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="60">{t('dialogs.everyMinute')}</option>
                <option value="3600">{t('dialogs.everyHour')}</option>
                <option value="86400">{t('dialogs.everyDay')}</option>
                <option value="604800">{t('dialogs.everyWeek')}</option>
              </select>
              <p className="muted">{t('dialogs.scheduleHelp')}</p>
            </>
          )}
          {dialog.type === 'settings' && (
            <fieldset className="appearance-fields">
              <legend>{t('dialogs.appearance')}</legend>
              <div className="segmented" role="radiogroup">
                {(['system', 'light', 'dark'] as ThemePreference[]).map(
                  (option) => (
                    <label key={option}>
                      <input
                        type="radio"
                        name="theme"
                        value={option}
                        checked={theme === option}
                        onChange={() => {
                          setTheme(option);
                          setThemePreference(option);
                        }}
                      />
                      <span>
                        {t(
                          `dialogs.${option}` as
                            'dialogs.system' | 'dialogs.light' | 'dialogs.dark',
                        )}
                      </span>
                    </label>
                  ),
                )}
              </div>
              <p className="muted">{t('dialogs.savedInBrowser')}</p>
            </fieldset>
          )}
          {dialog.type === 'settings' && (
            <div className="config-note">
              <strong>{t('dialogs.serviceSetup')}</strong>
              <p>
                {workspace.setup.missing.length ? (
                  <>
                    {t('dialogs.addMissing')}{' '}
                    {workspace.setup.missing.map((name, index) => (
                      <span key={name}>
                        {index > 0 && ', '}
                        <code>{name}</code>
                      </span>
                    ))}{' '}
                    {t('dialogs.addMissingSuffix')}
                  </>
                ) : (
                  t('dialogs.configPresent')
                )}
              </p>
              <p>
                {t('editor.slack')}:{' '}
                {workspace.setup.slack.replaceAll('_', ' ')}.{' '}
                {t('editor.voice')}:{' '}
                {workspace.setup.voice
                  ? t('dialogs.voiceConfigured')
                  : t('dialogs.voiceMissing')}
                .
              </p>
              <p>
                {t('dialogs.telemetry')}{' '}
                <a
                  href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP-TELEMETRY.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('dialogs.trackingDetails')}
                </a>
              </p>
              <a
                href="https://github.com/CopilotKit/OpenDots/blob/main/docs/SETUP.md"
                target="_blank"
                rel="noreferrer"
              >
                {t('dialogs.setupGuide')} ↗
              </a>
            </div>
          )}
          {dialog.type === 'memory' && (
            <p className="muted">{t('dialogs.memoryPrivacy')}</p>
          )}
          {error && (
            <p className="chat-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? t('dialogs.saving') : t('dialogs.save')}
          </button>
        </form>
      </section>
    </div>
  );
}
