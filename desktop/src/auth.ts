import { BrowserWindow, dialog, systemPreferences } from 'electron';

// Asks the person at the keyboard to confirm before a password is shown or
// copied: Touch ID where the Mac has it, otherwise a confirmation dialog.
// This runs in the app's main process, outside the page, so nothing the page
// or the agent does can answer it.
export async function confirmPresence(reason: string): Promise<boolean> {
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
    try {
      await systemPreferences.promptTouchID(reason);
      return true;
    } catch {
      return false;
    }
  }

  const parent = BrowserWindow.getFocusedWindow() ?? undefined;
  const options = {
    type: 'question' as const,
    message: reason,
    buttons: ['Continue', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
}
