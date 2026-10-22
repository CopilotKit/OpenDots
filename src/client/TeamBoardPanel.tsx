import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Dot } from '../shared/types';
import type { TeamBoard } from '../shared/team-board';
import { api, ApiError } from './api';

export function TeamBoardPanel({
  dots,
  onReview,
}: {
  dots: Dot[];
  onReview?: () => void;
}) {
  const [boards, setBoards] = useState<TeamBoard[]>([]);
  const [objective, setObjective] = useState('');
  const [participants, setParticipants] = useState<string[]>(
    dots.slice(0, 8).map((dot) => dot.id),
  );
  const [leadId, setLeadId] = useState(
    dots.find((dot) => dot.name === 'Project Manager')?.id ??
      dots.find((dot) => dot.name === 'Planner')?.id ??
      dots[0]?.id ??
      '',
  );
  const [rounds, setRounds] = useState(2);
  const [guidance, setGuidance] = useState('');
  const [directions, setDirections] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<'discussion' | 'improvement' | 'workflow'>(
    'workflow',
  );
  const developers = dots.filter(
    (dot) =>
      participants.includes(dot.id) &&
      dot.id !== leadId &&
      dot.toolGroups?.includes('developer'),
  );
  const [developerId, setDeveloperId] = useState('');
  const selectedDeveloper =
    developers.find((dot) => dot.id === developerId)?.id ?? developers[0]?.id;
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      void api<{ boards: TeamBoard[] }>(
        '/team-board',
        'GET',
        undefined,
        controller.signal,
      )
        .then((data) => {
          if (controller.signal.aborted) return;
          setBoards(data.boards);
          setLoaded(true);
          setLoadError('');
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted)
            setLoadError(
              e instanceof ApiError && e.status === 404
                ? 'The running server does not have Team board loaded. Restart OpenDots to load the updated server.'
                : e instanceof Error
                  ? e.message
                  : String(e),
            );
        });
    load();
    const timer = setInterval(load, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const name = (id: string | null) =>
    dots.find((dot) => dot.id === id)?.name ?? id ?? 'Owner';
  return (
    <div className="changes-panel">
      <h2>Team board</h2>
      <p>
        Give the team an objective. Each Dot shares its work, then the decision
        maker resolves the discussion. Existing tool permissions apply.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            const board = await api<TeamBoard>('/team-board', 'POST', {
              objective,
              participants,
              leadId,
              rounds,
              mode,
              guidance,
              ...(mode === 'improvement'
                ? { developerId: selectedDeveloper }
                : {}),
            });
            setBoards((previous) => [
              board,
              ...previous.filter((item) => item.id !== board.id),
            ]);
            setObjective('');
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Goal{' '}
          <select
            value={mode}
            onChange={(event) =>
              setMode(
                event.target.value as 'discussion' | 'improvement' | 'workflow',
              )
            }
          >
            <option value="discussion">Team decision</option>
            <option value="workflow">Manager-led execution</option>
            <option value="improvement">Improve OpenDots</option>
          </select>
        </label>
        {mode === 'improvement' && (
          <>
            <p>
              Describe the bug or desired behavior. The Developer implements and
              tests a change; you review and apply it in Changes.
            </p>
            <label>
              Developer{' '}
              <select
                value={selectedDeveloper ?? ''}
                onChange={(event) => setDeveloperId(event.target.value)}
              >
                {!developers.length && (
                  <option value="">
                    Select a participant with Code changes enabled
                  </option>
                )}
                {developers.map((dot) => (
                  <option key={dot.id} value={dot.id}>
                    {dot.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          Objective
          <textarea
            style={{ width: '100%', minHeight: 90 }}
            required
            minLength={3}
            maxLength={8000}
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
          />
        </label>
        <label>
          Execution guidance (optional)
          <textarea
            style={{ width: '100%' }}
            maxLength={4000}
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
            placeholder="For example: inspect src/client; report only verified findings; Files checks the implementation, Developer fixes it."
          />
        </label>
        <fieldset>
          <legend>Participants (2–8)</legend>
          {dots.map((dot) => (
            <label key={dot.id} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={participants.includes(dot.id)}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...participants, dot.id]
                    : participants.filter((id) => id !== dot.id);
                  setParticipants(next);
                  if (!next.includes(leadId)) setLeadId(next[0] ?? '');
                }}
              />{' '}
              {dot.name}
            </label>
          ))}
        </fieldset>
        <label>
          Decision maker{' '}
          <select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            {dots
              .filter((dot) => participants.includes(dot.id))
              .map((dot) => (
                <option key={dot.id} value={dot.id}>
                  {dot.name}
                </option>
              ))}
          </select>
        </label>
        {mode !== 'workflow' && (
          <label>
            {' '}
            Rounds{' '}
            <input
              aria-label="Discussion rounds"
              type="number"
              min={1}
              max={5}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
            />
          </label>
        )}
        <button
          type="submit"
          disabled={
            busy ||
            boards.some((board) => board.status === 'running') ||
            (mode === 'improvement' && !selectedDeveloper) ||
            !loaded ||
            !!loadError ||
            participants.length < 2 ||
            participants.length > 8 ||
            !participants.includes(leadId)
          }
        >
          {mode === 'improvement'
            ? 'Start improvement'
            : mode === 'workflow'
              ? 'Start workflow'
              : 'Start discussion'}
        </button>
        {boards.some((board) => board.status === 'running') && (
          <p>
            One team workflow runs at a time. Finish or stop the current board
            to start another.
          </p>
        )}
      </form>
      {error && <p role="alert">{error}</p>}
      {loadError && <p role="alert">{loadError}</p>}
      {!loaded && !loadError && <p>Loading team board…</p>}
      {loaded && !loadError && !boards.length && (
        <p>No team discussions yet.</p>
      )}
      {boards.map((board) => (
        <article className="change-card" key={board.id}>
          <strong>{board.objective}</strong>
          <p>
            {board.status} · {board.turns}/
            {board.mode === 'workflow'
              ? 50
              : board.rounds * board.participants.length}{' '}
            turns · Decision maker: {name(board.leadId)}
            {board.activeDotId && <> · Working: {name(board.activeDotId)}</>}
          </p>
          {board.status === 'running' && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                try {
                  const updated = await api<TeamBoard>(
                    `/team-board/${board.id}/guidance`,
                    'POST',
                    { guidance: directions[board.id] ?? '' },
                  );
                  setBoards((items) =>
                    items.map((item) =>
                      item.id === board.id ? updated : item,
                    ),
                  );
                  setDirections((items) => ({ ...items, [board.id]: '' }));
                  setError('');
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              <label>
                Adjust execution
                <textarea
                  maxLength={4000}
                  minLength={3}
                  required
                  value={directions[board.id] ?? ''}
                  onChange={(event) =>
                    setDirections((items) => ({
                      ...items,
                      [board.id]: event.target.value,
                    }))
                  }
                  placeholder="Replace the execution guidance for subsequent turns…"
                />
              </label>
              <button type="submit">Update direction</button>
              <p>
                Applies from the next turn. The current action is not
                interrupted.
              </p>
            </form>
          )}
          {board.status === 'running' && (
            <button
              onClick={async () => {
                try {
                  const stopped = await api<TeamBoard>(
                    `/team-board/${board.id}/stop`,
                    'POST',
                    {},
                  );
                  setBoards((items) =>
                    items.map((item) =>
                      item.id === stopped.id ? stopped : item,
                    ),
                  );
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Stop discussion
            </button>
          )}
          {board.error && <p role="status">{board.error}</p>}
          {!!board.steps?.length && (
            <ol>
              {board.steps.map((step) => (
                <li key={step.id}>
                  <strong>
                    {name(step.assigneeId)} · {step.status}
                  </strong>
                  <p>{step.task}</p>
                  <p>Done when: {step.acceptance}</p>
                  {step.result && <p>{step.result}</p>}
                  {step.evidence && (
                    <details>
                      <summary>Evidence</summary>
                      <pre style={{ whiteSpace: 'pre-wrap' }}>
                        {step.evidence}
                      </pre>
                    </details>
                  )}
                  {step.feedback && <p>Manager: {step.feedback}</p>}
                </li>
              ))}
            </ol>
          )}
          {!!board.reviewIds?.length && (
            <p>
              Submitted change{board.reviewIds.length > 1 ? 's' : ''}:{' '}
              {board.reviewIds.join(', ')}. Open Changes to inspect and apply.
              {onReview && <button onClick={onReview}>Review changes</button>}
            </p>
          )}
          {board.decision && (
            <>
              <h3>Decision</h3>
              <ReactMarkdown>{board.decision}</ReactMarkdown>
            </>
          )}
          <details>
            <summary>Discussion ({board.messages.length} messages)</summary>
            {board.messages.map((message) => (
              <section key={message.id}>
                <h4>
                  {name(message.dotId)}
                  {message.kind === 'evidence'
                    ? ' · Tool output'
                    : message.kind === 'guidance'
                      ? ' · Direction update'
                      : ''}
                </h4>
                <ReactMarkdown>{message.text}</ReactMarkdown>
              </section>
            ))}
          </details>
        </article>
      ))}
    </div>
  );
}
