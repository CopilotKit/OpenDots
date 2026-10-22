import type { Message } from '@ag-ui/core';

export const teamExecutionInstructions = `This is an automated team work turn, not a conversation with the owner.
Do useful work within your granted tools now. Do not ask whether to read the board, inspect files or proceed with already authorized work. Existing action confirmations still apply.
For already authorized actions, invoke the tool and let its confirmation mechanism enforce owner settings. Do not ask for an additional confirmation in chat: no owner reply is delivered into this scheduled turn. If an action is declined or genuinely needs new authorization, report_team_step with outcome blocked and the precise reason. Always report your result through report_team_step before ending a workflow specialist turn.
Use only the exact tools present in this turn's tool definitions. A tool mentioned by another teammate may not be available to you. After an unknown-tool or permission error, do not repeat the same call: use an available alternative or report the blocker.
Browser procedures are reusable, screen positions are not. After opening a menu, changing tabs, scrolling or navigating, inspect the returned current snapshot and locate the next target with browser_find. If text is insufficient, take a fresh browser screenshot and ground the target again. Never reuse coordinates from earlier screenshots or saved skills. After each action, verify the expected UI change before proceeding. Save the successful procedure using labels and verification criteria, not ref numbers or pixel coordinates.
Prior messages contain claims, plans and possibly errors. Only actual tool output establishes that an action ran. A missing result is missing evidence, not success. Never infer success from another agent saying "I will" or "I executed".
Use the supplied project scope; do not scan drive roots or unrelated folders to guess the project. If necessary context is missing, state the precise missing information.
Add new information only. Do not greet, restate the objective, narrate plans, quote earlier summaries or say the team needs to start. If your specialist role has no relevant contribution, say so in one sentence.
Finish with a compact report: Finding; Evidence (exact file, tool result or test); Blocker (if any); Next action and responsible teammate. Distinguish completed work from proposals. If nothing new was established, say "No new evidence" and explain the blocker briefly. Keep reports under 1500 characters unless code-review evidence requires more.`;

/** Share bounded receipts, not the model's claim that a tool ran. */
export function teamToolEvidence(messages: Message[]): string {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? [])
        names.set(call.id, call.function.name);
  }
  return messages
    .flatMap((message) => {
      if (message.role !== 'tool') return [];
      const name = names.get(message.toolCallId);
      if (
        !name ||
        [
          'read_team_board',
          'list_team_boards',
          'post_team_message',
          'assign_team_steps',
          'report_team_step',
          'checkpoint_team_step',
          'review_team_step',
        ].includes(name)
      )
        return [];
      return [`${name}: ${String(message.content).slice(0, 1200)}`];
    })
    .slice(-6)
    .join('\n\n');
}
