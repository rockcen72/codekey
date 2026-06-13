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

## Summary（任务摘要）— 安全固定摘要

> 当前 allowlist: `['type', 'summary', 'summaryShort', 'status']`
> summary/summaryShort 由 safeSummary() 生成固定短语，**不包含原文**

| 事件类型 | Claude Code | Codex | OpenCode |
|---|---|---|---|
| user_prompt | **仅 `type + summary + summaryShort`**（safeSummary: "User prompt"） | 同 CC | 同 CC |
| task_complete | **仅 `type + summary + summaryShort`**（safeSummary: "Task completed"） | 同 CC | 同 CC |
| error | — | **仅 `type + summary + summaryShort + status`** | **仅 `type + summary + summaryShort`** |
| approval_required | 全文（审批不投影） | — | 全文（审批不投影） |
| init attach 回放 | ✅ 投影 | — | ✅ 投影 |
| session.idle task_complete | ✅ 投影 | — | ✅ 投影 |
| phone command | 全文（始终可见） | 全文（始终可见） | 全文（始终可见） |

---

## 核心差异

```
Full   → 手机看到完整的 prompt 原文 + agent 输出文字
Summary → 手机只看到标题摘要，不知道用户问了什么、agent 答了什么
```

## 已知遗漏

以下路径为设计豁免，Summary 下仍发全文：

1. **审批事件** — approval_required / input_required 保留全文（用户需要详情做决策）
2. **phone command** — 手机发起的 user_prompt / command_started 保留全文（用户主动操作的本地回显）
