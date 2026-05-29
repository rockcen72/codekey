import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;

function channel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel('CodeKey');
  }
  return _channel;
}

export function log(fmt: unknown, ...args: unknown[]): void {
  let idx = 0;
  const line = typeof fmt === 'string'
    ? fmt.replace(/%[sdjof%]/g, (m) => {
        if (m === '%%') return '%';
        if (idx >= args.length) return m;
        const v = args[idx++];
        return typeof v === 'string' ? v : JSON.stringify(v);
      }) + (idx < args.length ? ' ' + args.slice(idx).map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') : '')
    : [fmt, ...args].map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  channel().appendLine(line);
}
