import * as vscode from 'vscode';
import { installHook, uninstallHook, isHookInstalled } from '../hook/installer.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import type { StatusBar } from '../status/bar.js';

const bridgeService = BridgeStatusService.getInstance();
let hookListenerDisposable: vscode.Disposable | null = null;

export async function enableHook(context: vscode.ExtensionContext, statusBar: StatusBar): Promise<void> {
  const alreadyInstalled = isHookInstalled();
  const choice = await vscode.window.showInformationMessage(
    alreadyInstalled
      ? 'CodeKey hook is currently installed. Disable it?'
      : 'Enable Claude Code interception? Bash permission requests will be forwarded to your phone for approval.',
    { modal: true },
    alreadyInstalled ? 'Disable' : 'Enable',
  );
  if (!choice) return;

  const output = vscode.window.createOutputChannel('CodeKey Hook');
  output.show();

  if (choice === 'Enable') {
    const scriptsDir = vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath;
    installHook(scriptsDir);

    try {
      bridgeService.ensureStarted();
    } catch (err) {
      uninstallHook();
      const msg = err instanceof Error ? err.message : 'Failed to start bridge';
      output.appendLine(`Enable Hook failed: ${msg}`);
      vscode.window.showErrorMessage(`CodeKey hook: ${msg}`);
      return;
    }

    context.subscriptions.push({
      dispose: () => { bridgeService.dispose(); },
    });

    hookListenerDisposable?.dispose();
    hookListenerDisposable = bridgeService.onDidChange((state) => {
      if (state.bridge === 'running') {
        statusBar.set('hook_active');
      } else {
        statusBar.set('paired');
      }
    });

    statusBar.set('hook_active');
    output.appendLine('Enable Hook: installed, bridge started');
    vscode.window.showInformationMessage('CodeKey hook enabled.');
  } else {
    uninstallHook();
    bridgeService.stop();
    hookListenerDisposable?.dispose();
    hookListenerDisposable = null;
    statusBar.set('paired');
    vscode.window.showInformationMessage('CodeKey hook disabled.');
  }
}
