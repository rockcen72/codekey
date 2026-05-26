import * as vscode from 'vscode';
import { loadCredentials } from '../auth/credentials.js';
import { showDashboardView } from '../webview/dashboard.js';
import type { StatusBar } from '../status/bar.js';

export async function showDashboard(
  context: vscode.ExtensionContext,
  statusBar: StatusBar,
): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    const action = 'Pair Now';
    vscode.window.showWarningMessage(
      'CodeKey is not paired. Pair your device first.',
      action,
    ).then((choice) => {
      if (choice === action) {
        vscode.commands.executeCommand('codekey.pairDevice');
      }
    });
    return;
  }

  try {
    const res = await fetch(`${creds.relayUrl}/health`);
    if (res.ok) {
      statusBar.set('paired');
    }
  } catch {
    statusBar.set('offline');
  }

  await showDashboardView(context, creds);
}
