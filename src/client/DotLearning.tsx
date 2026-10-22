import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from './api';

interface Skill {
  id: string;
  dotId: string | null;
  name: string;
  whenToUse: string;
  steps: string;
  uses: number;
}
interface Proposal {
  id: string;
  instructions: string;
  reason: string;
}

// What a Dot has taught itself: saved skills (removable) and any proposed
// change to its instructions, which only applies when the owner approves.
export function DotLearning({
  dotId,
  onApplied,
}: {
  dotId: string;
  onApplied: (instructions: string) => void;
}) {
  const [skills, setSkills] = useState<Skill[]>();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState('');
  const load = () =>
    api<{ skills: Skill[]; proposal: Proposal | null }>(`/dots/${dotId}/skills`)
      .then((data) => {
        setSkills(data.skills);
        setProposal(data.proposal);
      })
      .catch(() => setError('Could not load learned skills.'));
  useEffect(() => {
    void load();
  }, [dotId]);
  const act = (work: () => Promise<unknown>) =>
    work()
      .then(load)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed.'));

  return (
    <fieldset className="space-access-fields">
      <legend>Learning</legend>
      {proposal && (
        <div className="config-note">
          <strong>This Dot proposes new instructions</strong>
          <p>{proposal.reason}</p>
          <pre className="proposal-text">{proposal.instructions}</pre>
          <div className="proposal-actions">
            <button
              type="button"
              className="primary"
              onClick={() =>
                void act(async () => {
                  await api(`/proposals/${proposal.id}/apply`, 'POST', {});
                  onApplied(proposal.instructions);
                })
              }
            >
              Apply
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                void act(() =>
                  api(`/proposals/${proposal.id}/dismiss`, 'POST', {}),
                )
              }
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {!skills ? (
        <p className="muted">Loading…</p>
      ) : skills.length ? (
        <ul className="skill-list">
          {skills.map((skill) => (
            <li key={skill.id}>
              <button
                type="button"
                className="text-button skill-name"
                onClick={() =>
                  setOpen(open === skill.id ? undefined : skill.id)
                }
              >
                {skill.name}
                {skill.dotId === null ? ' (shared)' : ''}
              </button>
              <small>
                {skill.whenToUse} · used {skill.uses}×
              </small>
              <button
                type="button"
                className="icon-button"
                aria-label={`Forget ${skill.name}`}
                onClick={() =>
                  void act(() => api(`/skills/${skill.id}`, 'DELETE'))
                }
              >
                <Trash2 size={14} />
              </button>
              {open === skill.id && (
                <pre className="proposal-text">{skill.steps}</pre>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          No learned skills yet. With Self-improvement on, this Dot saves what
          works after multi-step tasks or when you correct it.
        </p>
      )}
      {error && <p className="chat-error">{error}</p>}
    </fieldset>
  );
}
