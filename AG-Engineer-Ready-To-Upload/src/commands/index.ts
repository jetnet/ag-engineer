/**
 * Command registrations for Antigravity Engineer.
 */
import * as vscode from 'vscode';
import { showOutputChannel } from '../logging/logger';

export interface CommandHandlers {
  refreshNow: () => void;
  resetState: () => Promise<void>;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  handlers: CommandHandlers,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityEngineer.openDashboard', () => {
      // Focus the sidebar view
      vscode.commands.executeCommand('antigravityEngineer.dashboard.focus');
    }),

    vscode.commands.registerCommand('antigravityEngineer.refreshNow', () => {
      handlers.refreshNow();
    }),

    vscode.commands.registerCommand('antigravityEngineer.showDiagnostics', () => {
      showOutputChannel();
    }),

    vscode.commands.registerCommand('antigravityEngineer.resetState', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Reset all AG Engineer cached state? This will re-discover the language server.',
        'Reset',
        'Cancel',
      );
      if (answer === 'Reset') {
        await handlers.resetState();
        vscode.window.showInformationMessage('AG Engineer state reset.');
      }
    }),
  );
}
