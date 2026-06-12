# 事件投影对比表

> 日期: 2026-06-12 | 投影含义: 只保留 allowedFields 中的字段，其余删除

---

## Full（会话过程）— 全量推送

| 事件类型 | Claude Code | Codex | OpenCode |
|---|---|---|---|
| user_prompt | prompt + summary + timestamp | prompt + summary | prompt + summary |
| task_complete | summary + output（完整文字） | summary + output | summary + output |
| approval_required | action + command + risk + summary | — | action + command + risk + summary |
| error | — | message + toolName | message |
| session_idle | idleMinutes | — | summary（合成 task_complete） |
| phone command | command | command | command |

## Summary（任务摘要）— 仅保留 summary

| 事件类型 | Claude Code | Codex | OpenCode |
|---|---|---|---|
| user_prompt | **仅 summary**（prompt/timestamp 裁剪） | **仅 summary**（prompt 裁剪） | **仅 summary** |
| task_complete | **仅 summary**（output 裁剪） | **仅 summary**（output 裁剪） | **仅 summary** |
| approval_required | 全文（审批不投影） | — | 全文（审批不投影） |
| error | — | ⚠️ 变空对象或仅 status | ⚠️ 全文（未传 allowedFields） |
| init attach 回放 | ✅ 已投影 | — | ⚠️ 全文（未传 allowedFields） |
| session.idle task_complete | ✅ 已投影 | — | ⚠️ 全文（未传 allowedFields） |
| phone command | 全文（始终可见） | 全文（始终可见） | 全文（始终可见） |

---

## 核心差异

```
Full   → 手机看到完整的 prompt 原文 + agent 输出文字
Summary → 手机只看到标题摘要，不知道用户问了什么、agent 答了什么
```

## 已知遗漏

以下路径未传递 `allowedFields` 参数，Summary 模式下仍发全文：

1. **OpenCode init attach 回放** — `_replayOpenCodeHistory()`（handler.ts）
2. **OpenCode idle/error 事件** — `onSessionIdle()`、`onSessionError()`（opencode-session-manager.ts）
3. **Codex error 事件** — Summary 下 `message` 不在 allowedFields 中，事件变空对象
