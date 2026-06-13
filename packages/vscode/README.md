# CodeKey

<img src="https://raw.githubusercontent.com/rockcen72/codekey/master/packages/vscode/media/codekey-icon.png" width="100" alt="CodeKey icon" />

**AI coding remote control for your phone**

Remote control for AI agents, with local-first privacy controls.

---

## Why CodeKey

AI coding agents often pause at the worst possible moment: waiting for permission to write a file, run a command, continue a task, or answer a question.
CodeKey moves those waiting points from your desktop to your phone.

- Receive approval cards instantly on mobile
- Send follow-up prompts from your phone
- Manage local Claude Code, Codex, and OpenCode sessions in one VS Code sidebar
- Control history sharing per agent
- Redact secrets and block sensitive paths before anything leaves your machine

## At a glance

**VS Code sidebar** — Pair devices, manage sessions, handle approvals

<img src="https://raw.githubusercontent.com/rockcen72/codekey/master/packages/vscode/media/readme-sidebar.png" width="100%" alt="VS Code sidebar" />

**Mobile session list** — Filter by agent and resume active work

<img src="https://raw.githubusercontent.com/rockcen72/codekey/master/packages/vscode/media/readme-mobile-history.jpg" width="100%" alt="Mobile history" />

**Mobile session detail** — Chat-style timeline, send next prompt

<img src="https://raw.githubusercontent.com/rockcen72/codekey/master/packages/vscode/media/readme-mobile-session.jpg" width="100%" alt="Mobile session" />

## Key features

| Feature | What it does |
| --- | --- |
| Mobile approvals | Permission requests from Claude Code, Codex, and OpenCode appear on your phone with approve, deny, and reply actions. |
| Remote prompts | Type a prompt on mobile and your local VS Code agent continues the task. |
| Session sync | View local agent sessions by runtime, status, and recent activity. |
| VS Code control panel | Pair devices, manage sync, inspect local sessions, and watch approval cards from the sidebar. |
| Mobile apps | Works with WeChat Mini Program and Telegram Mini App. |

## Privacy protection

CodeKey uses a local privacy pipeline before forwarding events to the relay server.
You decide how much session history, if any, is visible on mobile.

| Mode | What mobile can see | Best for |
| --- | --- | --- |
| Off | Approval cards only. No session history. | Maximum data minimization |
| Summary | Safe status summaries without raw prompt or output text. | Progress tracking without exposing content |
| Full | Full session history, still filtered by local secret scanning and blocklists. | Rich remote monitoring and follow-up prompts |

Privacy controls include:

- Secret scanning: redact API keys, tokens, passwords, and similar sensitive values locally
- Blocklist / `.codekeyignore`: prevent selected files and paths from being forwarded
- Field projection: Summary mode keeps only safe event type, state, and summary fields
- Audit panel: inspect forwarded, blocked, and sanitized event counts in the sidebar
- Per-agent policy: configure Claude Code, Codex, and OpenCode independently

## Getting started

1. Install the CodeKey VS Code extension
2. Open the CodeKey view from the Activity Bar
3. Click Pair Device and scan the QR code with WeChat or Telegram
4. Start Claude Code, Codex, or OpenCode
5. Approve, monitor, and send prompts from your phone

## Commands

| Command | Description |
| --- | --- |
| `CodeKey: Pair Device` | Pair a mobile device |
| `CodeKey: Show Dashboard` | Open the management dashboard |
| `CodeKey: Enable Hook` | Enable Claude Code hooks |
| `CodeKey: Enable OpenCode Integration` | Enable OpenCode integration |
| `CodeKey: Start Codex Session` | Start a Codex session |
| `CodeKey: Toggle Debug Log` | Toggle verbose debug logging |

## Requirements

- VS Code 1.96+
- Claude Code CLI, Codex CLI, or OpenCode
- WeChat Mini Program or Telegram Mini App

## HTML guide

The package also includes `README.html`, a standalone bilingual product guide.
Open it in a browser to get automatic English/Chinese switching based on system language, with a manual language toggle.

## License

Apache 2.0
