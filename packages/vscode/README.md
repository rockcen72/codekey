# CodeKey

![CodeKey icon](https://codekey.tinymoney.cn/assets/readme/codekey-icon-v1.png)

**AI coding remote control for your phone**

Remote control for AI agents, with E2E-protected prompts, commands, task summaries, and local-first privacy controls.

---

## Why CodeKey

AI coding agents often pause at the worst possible moment: waiting for permission to write a file, run a command, continue a task, or answer a question.
CodeKey moves those waiting points from your desktop to your phone.

- Receive approval cards instantly on mobile
- Send follow-up prompts from your phone
- Manage local Claude Code, Codex, and OpenCode sessions in one VS Code sidebar
- Control history sharing per agent
- Protect user prompts, phone-to-desktop commands, and task completion summaries with E2E encryption when paired
- Redact secrets and block sensitive paths before anything leaves your machine

## At a glance

<table>
  <tr>
    <td align="center" width="33%">
      <img src="https://codekey.tinymoney.cn/assets/readme/sidebar-v1.png" height="320" alt="VS Code sidebar" />
    </td>
    <td align="center" width="33%">
      <img src="https://codekey.tinymoney.cn/assets/readme/mobile-history-v1.jpg" height="320" alt="Mobile history" />
    </td>
    <td align="center" width="33%">
      <img src="https://codekey.tinymoney.cn/assets/readme/mobile-session-v1.jpg" height="320" alt="Mobile session" />
    </td>
  </tr>
  <tr>
    <td align="center" valign="top">
      <strong>VS Code sidebar</strong><br />
      Pair devices, manage sessions, handle approvals.
    </td>
    <td align="center" valign="top">
      <strong>Mobile session list</strong><br />
      Filter by agent and resume active work.
    </td>
    <td align="center" valign="top">
      <strong>Mobile session detail</strong><br />
      Chat-style timeline, send the next prompt.
    </td>
  </tr>
</table>

## Key features

| Feature | What it does |
| --- | --- |
| Mobile approvals | Permission requests from Claude Code, Codex, and OpenCode appear on your phone with approve, deny, and reply actions. |
| Remote prompts | Type a prompt on mobile and your local VS Code agent continues the task. |
| Session sync | View local agent sessions by runtime, status, and recent activity. |
| VS Code control panel | Pair devices, manage sync, inspect local sessions, and watch approval cards from the sidebar. |
| E2E encryption | User-entered prompts, phone-to-desktop commands, and task completion summaries are encrypted before they pass through the relay. |
| Mobile apps | Works with WeChat Mini Program and Telegram Mini App. |

## Privacy protection

CodeKey combines end-to-end encryption with a local privacy pipeline before
anything is forwarded to the relay server. You decide how much session history,
if any, is visible on mobile.

When E2E is enabled, user-entered prompt bodies, phone-to-desktop command text,
and task completion summaries/results are sealed with AES-GCM on the sending
device. Telegram pairing derives the shared content key with ECDH; WeChat QR
pairing carries the content key directly to the phone. The relay forwards
encrypted envelopes (`sealed_payload` / `sealed_command`) and routing metadata,
but it does not receive the raw text for those protected paths.

| Mode | What mobile can see | Best for |
| --- | --- | --- |
| Off | Approval cards only. Session history is not shared to mobile history. | Maximum data minimization |
| Summary | Safe status summaries without raw prompt or agent output text. | Progress tracking with less content exposure |
| Full | Full session history after local secret scanning and blocklist checks. | Rich remote monitoring and follow-up prompts |

Privacy controls include:

- End-to-end encryption: protect user prompts, mobile commands, and task completion summaries from relay-side plaintext storage
- Secret scanning: redact API keys, tokens, passwords, and similar sensitive values locally
- Blocklist / `.codekeyignore`: prevent selected files and paths from being forwarded
- Field projection: Summary mode keeps only safe event type, state, and summary fields
- Audit panel: inspect forwarded, blocked, and sanitized event counts in the sidebar
- Per-agent policy: configure Claude Code, Codex, and OpenCode independently
- Stale-key detection: mobile settings warn when a phone needs to re-pair after key rotation

Important boundaries:

- Approval and input cards still send the content required for you to approve, deny, or reply from mobile.
- E2E currently protects user prompt bodies, mobile command bodies, and task completion summaries/results. Intermediate agent streaming output and broader history visibility still depend on your Off / Summary / Full policy.
- Summary mode reduces history detail with safe summaries and field projection.
- Full mode is intended for convenience and observability; do not enable it for repositories where remote history visibility is not acceptable.

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
