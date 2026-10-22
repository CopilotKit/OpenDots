// Tool groups a Dot can be granted. Local MCP tools are mapped to groups by
// name; tools from any other MCP server form a group named after that server.
export const toolGroups = {
  files: {
    label: 'Files',
    description: 'List, search, read, write, copy, move and recycle files.',
    tools: [
      'list_directory',
      'find_files',
      'read_text_file',
      'write_text_file',
      'make_directory',
      'copy_path',
      'move_paths',
      'delete_to_recycle_bin',
    ],
  },
  vision: {
    label: 'Image reading',
    description: 'Describe images or the screen, read text in them.',
    tools: ['describe_image', 'take_screenshot'],
  },
  detection: {
    label: 'Object detection',
    description: 'Locate objects in images or the screen with YOLO.',
    tools: ['detect_objects', 'take_screenshot'],
  },
  pc_control: {
    label: 'PC control',
    description:
      'Windows, mouse, keyboard and opening apps (asks before acting).',
    tools: [
      'list_windows',
      'focus_window',
      'mouse_click',
      'type_text',
      'press_keys',
      'scroll',
      'open_path',
      'open_url',
      'launch_app',
      'list_apps',
      'take_screenshot',
      'system_info',
    ],
  },
  browser: {
    label: 'Web browser',
    description:
      'Its own Chrome window: open sites, read, click, type, fill forms (asks before submitting).',
    tools: [
      'browser_open',
      'browser_snapshot',
      'browser_find',
      'browser_procedure_recall',
      'browser_jev_find',
      'browser_jev_check',
      'browser_teach_start',
      'browser_teach_finish',
      'browser_teach_status',
      'browser_teach_cancel',
      'browser_map_propose',
      'browser_map_finish',
      'browser_region_capture',
      'browser_targets',
      'browser_target_find',
      'browser_target_forget',
      'browser_menu_map',
      'browser_menu_find',
      'browser_procedure_start',
      'browser_procedure_finish',
      'browser_procedure_forget',
      'browser_visual_click',
      'browser_visual_type',
      'browser_read',
      'browser_click',
      'browser_click_sequence',
      'browser_choose_asset',
      'browser_place_trade',
      'browser_set_expiry',
      'browser_chart_read',
      'browser_trade_journal',
      'browser_type',
      'browser_select',
      'browser_press',
      'browser_scroll',
      'browser_back',
      'browser_tabs',
      'browser_switch_tab',
      'browser_screenshot',
      'browser_close',
    ],
  },
  web: {
    label: 'Web search',
    description: 'Search DuckDuckGo and read public pages (queries leave PC).',
    tools: ['web_search', 'fetch_page'],
  },
  memory: {
    label: 'Long-term memory',
    description: 'Search past conversations and indexed folders.',
    tools: ['search_memory', 'index_folder'],
  },
  developer: {
    label: 'Code changes (Developer)',
    description:
      "Edit OpenDots' own code on a separate branch, run tests, and submit changes for your review.",
    tools: [
      'dev_start',
      'dev_status',
      'dev_overview',
      'dev_list',
      'dev_read',
      'dev_search',
      'dev_edit',
      'dev_write',
      'dev_checks',
      'dev_diff',
      'dev_submit',
      'dev_discard',
    ],
  },
  self_improve: {
    label: 'Self-improvement',
    description:
      'Save procedures that worked as skills, and propose instruction changes for your approval.',
    tools: [
      'save_skill',
      'read_skill',
      'list_skills',
      'propose_instruction_change',
    ],
  },
  delegation: {
    label: 'Delegate to Dots',
    description: 'Hand tasks to other specialist Dots and use their answers.',
    tools: [
      'list_specialists',
      'delegate_task',
      'start_team_board',
      'start_team_workflow',
    ],
  },
} as const;
export type ToolGroup = keyof typeof toolGroups;
export const allToolGroups = Object.keys(toolGroups) as ToolGroup[];
/** Groups granted to Dots created before per-Dot permissions existed. */
export const legacyToolGroups: string[] = [
  'files',
  'vision',
  'detection',
  'pc_control',
  'memory',
];
export const defaultToolGroups: string[] = ['memory'];
export const localServer = 'localtools';
/** Group for a tool from an MCP server; null when not grantable. */
export function groupsForTool(server: string, tool: string): string[] {
  if (server !== localServer) return [`mcp:${server}`];
  return allToolGroups.filter((group) =>
    (toolGroups[group].tools as readonly string[]).includes(tool),
  );
}
export function allowsTool(granted: string[], server: string, tool: string) {
  return groupsForTool(server, tool).some((group) => granted.includes(group));
}
