import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('CodeKey');
  }
  return _channel;
}

export function log(...args: unknown[]): void {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  channel().appendLine(line);
}
