import { describe, expect, it } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { MemoryIndex, chunk } from '../src/server/memory-index.js';
import { ModelRegistry } from '../src/server/models.js';
import { starterTeam } from '../src/server/team.js';
import {
  allowsTool,
  groupsForTool,
  legacyToolGroups,
} from '../src/shared/capabilities.js';
import { globToRegExp, nextDailyRun } from '../src/shared/triggers.js';

describe('tool groups', () => {
  it('maps local tools to groups and other servers to their own group', () => {
    expect(groupsForTool('localtools', 'move_paths')).toEqual(['files']);
    expect(groupsForTool('localtools', 'take_screenshot')).toEqual([
      'vision',
      'detection',
      'pc_control',
    ]);
    expect(groupsForTool('blender', 'run')).toEqual(['mcp:blender']);
    expect(allowsTool(['files'], 'localtools', 'mouse_click')).toBe(false);
    expect(allowsTool(['pc_control'], 'localtools', 'mouse_click')).toBe(true);
    expect(allowsTool([], 'localtools', 'unknown_tool')).toBe(false);
    expect(groupsForTool('localtools', 'browser_click')).toEqual([
      'browser',
      'site_mapping', // The Site Mapper clicks through pages too.
    ]);
    expect(allowsTool(['web'], 'localtools', 'browser_type')).toBe(false);
  });
});

describe('per-Dot models and tools', () => {
  it('keeps legacy Dots working, seeds the team once, and resolves model roles', () => {
    const ws = new WorkspaceStore(':memory:', 'owner');
    expect(ws.dots()[0].toolGroups).toEqual(legacyToolGroups);
    ws.seedTeam(starterTeam);
    expect(ws.dots().find((d) => d.name === 'Dot')!.toolGroups).toContain(
      'browser',
    );
    const names = ws.dots().map((dot) => dot.name);
    expect(names).toEqual(
      expect.arrayContaining(['Planner', 'Files', 'Vision']),
    );
    const planner = ws.dots().find((dot) => dot.name === 'Planner')!;
    ws.updateDot(planner.id, { ...planner, toolGroups: ['delegation'] });
    // Deleted or edited Dots are never re-seeded.
    ws.seedTeam(starterTeam);
    expect(ws.dots().filter((dot) => dot.name === 'Planner')).toHaveLength(1);
    expect(ws.dot(planner.id)!.toolGroups).toEqual(['delegation']);
    const models = new ModelRegistry(ws, 'heavy', 'http://x/v1');
    expect(models.forDot(planner)).toBe('qwen3:4b');
    models.update({ plannerModel: 'tiny' });
    expect(models.resolve('@planner')).toBe('tiny');
    expect(models.resolve(null)).toBe('heavy');
    expect(models.resolve('custom:1b')).toBe('custom:1b');
    ws.close();
  });
});

describe('triggers', () => {
  it('schedules daily runs on allowed weekdays', () => {
    const monday9am = new Date(2026, 9, 5, 9, 0).getTime(); // Mon 5 Oct 2026
    const next = new Date(
      nextDailyRun({ type: 'daily', time: '08:30', days: [1, 3] }, monday9am),
    );
    expect(next.getDay()).toBe(3);
    expect([next.getHours(), next.getMinutes()]).toEqual([8, 30]);
  });
  it('waits for file events and carries the event into the next run', () => {
    const store = new Store(':memory:');
    const task = store.createTask(
      'Summarize it',
      null,
      JSON.stringify({ type: 'file', folder: 'C:/x', pattern: '*.pdf' }),
    );
    expect(store.claim()).toBeNull();
    store.fire(task.id, 'New file: C:/x/a.pdf');
    const claim = store.claim()!;
    expect(claim.pendingInput).toBe('New file: C:/x/a.pdf');
    store.fire(task.id, 'New file: C:/x/b.pdf');
    store.finish(claim, { text: 'ok', sources: [], sample: false });
    expect(store.claim()!.pendingInput).toBe('New file: C:/x/b.pdf');
    expect(globToRegExp('*.pdf').test('Report.PDF')).toBe(true);
    expect(globToRegExp('*.pdf').test('a.pdf.tmp')).toBe(false);
    store.close();
  });
});

describe('long-term memory', () => {
  it('indexes conversations once and ranks by similarity', async () => {
    const embed = async (texts: string[]) =>
      texts.map((text) => [
        /cat/i.test(text) ? 1 : 0,
        /invoice/i.test(text) ? 1 : 0,
        0.1,
      ]);
    const memory = new MemoryIndex(':memory:', '', 'fake', embed);
    const messages = [
      { id: 'a', role: 'user', content: 'My cat is called Miso.' },
      { id: 'b', role: 'assistant', content: 'Your invoice is due Friday.' },
    ] as never;
    expect(await memory.indexConversation('t1', 'Chat', messages)).toBe(2);
    expect(await memory.indexConversation('t1', 'Chat', messages)).toBe(0);
    const [top] = await memory.search('what is my cat called?');
    expect(top.text).toContain('Miso');
    expect(chunk('x'.repeat(3000)).length).toBe(3);
  });
});

describe('self-improvement', () => {
  it('saves, updates and recalls skills, and keeps instruction changes pending', async () => {
    const { SkillStore } = await import('../src/server/skills.js');
    const embed = async (texts: string[]) =>
      texts.map((text) =>
        Float32Array.from([
          /wiki/i.test(text) ? 1 : 0,
          /file/i.test(text) ? 1 : 0,
          0.1,
        ]),
      );
    const skills = new SkillStore(':memory:', embed);
    await skills.save({
      dotId: 'a',
      name: 'Search Wikipedia',
      whenToUse: 'wiki lookups',
      steps: 'v1',
    });
    await skills.save({
      dotId: 'a',
      name: 'search wikipedia',
      whenToUse: 'wiki lookups',
      steps: 'v2',
    });
    await skills.save({
      dotId: null,
      name: 'Organize files',
      whenToUse: 'file cleanup',
      steps: 's',
    });
    await skills.save({
      dotId: 'b',
      name: 'Private',
      whenToUse: 'other dot',
      steps: 's',
    });
    // Same name updates instead of duplicating; shared skills are visible to all.
    expect(
      skills
        .list('a')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['Organize files', 'Search Wikipedia']);
    expect(skills.get('a', 'SEARCH WIKIPEDIA')?.steps).toBe('v2');
    const [top] = await skills.relevant('a', 'look this up on wikipedia');
    expect(top.name).toBe('Search Wikipedia');
    expect(await skills.relevant('a', 'unrelated cooking question')).toEqual(
      [],
    );
    // Only one pending proposal per Dot; resolving it clears it.
    skills.propose(
      'a',
      'old proposal text that is long enough',
      'first reason',
    );
    const latest = skills.propose(
      'a',
      'new instructions that are long enough',
      'better',
    );
    expect(skills.pending('a')?.id).toBe(latest.id);
    skills.resolve(latest.id, 'dismissed');
    expect(skills.pending('a')).toBeUndefined();
    skills.close();
  });
});
