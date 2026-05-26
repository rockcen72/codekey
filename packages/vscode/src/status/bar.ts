import * as vscode from 'vscode';

export type DeviceStatus = 'unpaired' | 'paired' | 'checking' | 'offline';

const TEXT: Record<DeviceStatus, string> = {
  unpaired: '$(key) CodeKey: Not Paired',
  paired: '$(check) CodeKey: Ready',
  checking: '$(loading~spin) CodeKey: Checking...',
  offline: '$(circle-slash) CodeKey: Offline',
};

export class StatusBar {
  private item: vscode.StatusBarItem;
  private _status: DeviceStatus = 'unpaired';

  constructor(command: string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = command;
    this.item.tooltip = 'Click to open CodeKey Dashboard';
    this.item.show();
    this.set('unpaired');
  }

  get status(): DeviceStatus { return this._status; }

  set(status: DeviceStatus): void {
    this._status = status;
    this.item.text = TEXT[status];
  }

  dispose(): void {
    this.item.dispose();
  }
}
