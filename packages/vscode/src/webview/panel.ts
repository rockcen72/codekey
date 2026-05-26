import * as vscode from 'vscode';

export function createHtml(title: string, bodyHtml: string): string {
  const style = `
    body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-editor-foreground); }
    h1 { font-size: 18px; font-weight: 600; }
    h2 { font-size: 14px; font-weight: 600; margin-top: 20px; }
    .code { font-family: monospace; background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; }
    .status { padding: 8px 12px; border-radius: 6px; margin: 8px 0; }
    .status.offline { background: #b71c1c; color: #ef9a9a; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .event { padding: 8px 12px; border-left: 3px solid var(--vscode-textLink-foreground); margin-bottom: 8px; }
    .event .time { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .event .summary { font-size: 13px; margin-top: 4px; }
    .event .meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; }
    td, th { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--vscode-editor-lineHighlightBorder); }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>${style}</style></head>
<body>${bodyHtml}</body>
</html>`;
}

export function showWebView(
  context: vscode.ExtensionContext,
  title: string,
  bodyHtml: string,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    'codekey',
    title,
    vscode.ViewColumn.One,
    { enableScripts: false, retainContextWhenHidden: true },
  );
  panel.webview.html = createHtml(title, bodyHtml);
  return panel;
}
