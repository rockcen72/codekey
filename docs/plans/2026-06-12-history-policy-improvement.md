# 事件共享策略改进计划（修订版）

> 日期: 2026-06-12 | 状态: 待实施
> 修订: 明确 safeSummary 位置、phone command 语义、allowlist 矛盾、测试矩阵

---

## 一、现状问题

### 1.1 Summary 模式仍泄露原文（P0）

当前 `summary` 字段**不是安全摘要**，多数情况下就是原文或原文截断：

| 场景 | 代码 | summary 内容 |
|------|------|-------------|
| CC user_prompt | `summary: entry.text.slice(0, 200)` | 用户 prompt 前 200 字 |
| CC task_complete | `summary: entry.text` | assistant 完整输出 |
| Codex user_prompt | `summary: text.slice(0, 200)` | 用户 prompt 前 200 字 |
| OpenCode task_complete | `summary: text` | agent 完整输出 |

结论：Summary 模式虽裁掉了 `prompt`/`output`，但 `summary` 等于原文片段，**实际仍泄露内容**。

### 1.2 Off 模式未完全落地（P0）

Off 定义为"只发审批/输入请求"，但以下路径绕过了策略检查：

| Agent | 路径 | 问题 |
|-------|------|------|
| Claude Code | `handleHookEvent` → `privacyCheckAndSend('approval', ...)` | task_complete/session_idle hook 直接走审批管道，不检查 history policy |
| Codex | `_forwardEvent()` | 目前用 `skipProjection` boolean 区分 phone command 和 content，未按 policy.allowed 拦截 |

### 1.3 OpenCode 漏传 allowedFields（P1）

| 路径 | 文件 | 状态 |
|------|------|------|
| `_replayOpenCodeHistory()` | handler.ts:298 | 未传 |
| `onSessionIdle()` task_complete | opencode-session-manager.ts:582 | 未传 |
| `onSessionError()` error | opencode-session-manager.ts:612 | 未传 |
| `replayHistory()` | opencode-session-manager.ts:265 | ✅ 已传 |
| `onMessagePartUpdated()` | opencode-session-manager.ts:777 | ✅ 已传 |

额外问题：`_replayOpenCodeHistory()` 与 `replayHistory()` **两套 replay 实现**，行为容易漂移。

### 1.4 Codex error 在 Summary 下信息丢失（P2）

`allowedFields` 为 `['summary', 'metadata', 'status', 'basename']`，Codex error 的 `message`/`toolName` 不在其中，导致 Summary 下事件变空对象。

### 1.5 "最近 5 条" 误导（P2）

`maxCount = 5` 只限制历史回放（attach/init replay），会话进行中的实时事件不受此限制。UI 文案需区分。

### 1.6 allowlist 内部矛盾（P1）

当前 `allowedFields = ['summary', 'metadata', 'status', 'basename']`：
- `basename` 本身就是文件名 → 泄露工作内容
- `metadata` 可能包含路径、命令、参数 → 泄露敏感信息
- 但约束要求"不含文件名和原文" → 自相矛盾

---

## 二、目标设计

### 2.1 三档语义

| 模式 | 行为 |
|------|------|
| **Off** | 只发审批/输入请求（approval_required、input_required）。**例外**：phone command 的 user_prompt/command_started 仍发送（用户主动操作需要本地回显） |
| **Full** | 历史回放最近 5 条 + 实时全量推送 |
| **Summary** | 历史回放最近 5 条 + 实时事件，**只发安全摘要字段，不含原文/文件名/路径** |

### 2.2 统一投影入口

新增 **`projectHistoryEventForPolicy(rawPayload, policy, contentPolicy = 'enforce')`**，在 `privacy-pipeline.ts` 中实现：

```
// policy 是 checkHistoryPolicy() 返回的 PolicyResult，不是字符串
当 !policy.allowed && contentPolicy === 'enforce'   → 拒绝
当 !policy.allowed && contentPolicy !== 'enforce'   → 豁免（approval-exempt / phone-originated）
当 policy.allowed && !policy.allowedFields           → Full，不投影，全文通过
当 policy.allowedFields                              → Summary，先 safeSummary() 再 projectAllowedFields()
```

调用方只传 `policy` 和 `contentPolicy`，**不负责记住安全化细节**。

### 2.3 safeSummary() 规则

不读取原文内容，只基于元信息生成固定短语：

| eventType | summary 内容 |
|-----------|-------------|
| user_prompt | `"User prompt"` |
| task_complete | `"Task completed"` |
| error | `"Error occurred"` |
| command_started | `"Command sent from phone"` |
| approval_required | 保留原文（审批需要详情） |
| input_required | `"Input requested"` |

### 2.4 allowlist 修订

```
SANITIZED_ALLOWED_FIELDS = ['type', 'summary', 'summaryShort', 'status']
```

移除 `metadata`（泄露路径/命令）和 `basename`（泄露文件名）。`type` 始终保留以区分事件类型。

### 2.5 Codex 事件分类参数

`_forwardEvent()` 的 `skipProjection` boolean 改为语义枚举：

```typescript
type ContentPolicy = 'enforce' | 'phone-originated' | 'approval-exempt';
```

| 值 | 含义 |
|----|------|
| `enforce` | 按 policy 决定（默认） |
| `phone-originated` | 豁免 policy 检查，始终发送（用户主动命令） |
| `approval-exempt` | 豁免 history policy，但走 secret scan（审批事件） |

### 2.6 合并 OpenCode replay

删除 `opencode-session-manager.ts` 中的 `replayHistory()`（未被调用），统一用 `handler.ts` 的 `_replayOpenCodeHistory()`，并在其中调用 `projectHistoryEventForPolicy`。

---

## 三、实施任务

### P0 — 新增统一投影函数

- [ ] `privacy-pipeline.ts`: 实现 `projectHistoryEventForPolicy(rawPayload: string, policy: PolicyResult, contentPolicy: ContentPolicy = 'enforce'): string`
  - Off → policy.allowed = false 时拒绝（除 approval-exempt/phone-originated）
  - Summary → 调 `safeSummary()` → 再调 `projectAllowedFields()`
  - Full → 原文通过
- [ ] `privacy-pipeline.ts`: 实现 `safeSummary(eventType, agent, toolKind?)` 返回固定短语
- [ ] `history-policy.ts`: `allowlist` 改为 `['type', 'summary', 'summaryShort', 'status']`

### P0 — 所有发送路径改用统一入口

- [ ] `handler.ts` syncClaudeTranscript: `privacyCheckAndSend` → `projectHistoryEventForPolicy` + send
- [ ] `codex-resume-manager.ts` _forwardEvent: `skipProjection` → `ContentPolicy`
- [ ] `opencode-session-manager.ts` onMessagePartUpdated / onMessageUpdated: 改用统一入口

### P0 — Off 模式拦截

- [ ] `handler.ts` handleHookEvent: task_complete/session_idle hook 加入 checkHistoryPolicy
- [ ] `codex-resume-manager.ts` _forwardEvent: ContentPolicy='enforce' 时检查 policy.allowed
- [ ] 审批事件标记为 `approval-exempt`（仍走 secret scan/blocklist）
- [ ] phone command 标记为 `phone-originated`（不拦，写注释说明例外语义）

### P1 — OpenCode 补 projection

- [ ] 删除 `opencode-session-manager.ts` `replayHistory()` 死代码
- [ ] `handler.ts` `_replayOpenCodeHistory()`: 改用 `projectHistoryEventForPolicy`
- [ ] `opencode-session-manager.ts` `onSessionIdle()`: 改用 `projectHistoryEventForPolicy`
- [ ] `opencode-session-manager.ts` `onSessionError()`: 改用 `projectHistoryEventForPolicy`

### P2 — Codex error 安全化

- [ ] `codex-resume-manager.ts` error 事件: `summary = "Codex tool failed"` / `status = toolName`
- [ ] 验证 Summary 下 error 不为空且不含原始 message

### P2 — UI 文案

- [ ] 下拉选项 tooltip/注释区分"历史回放 5 条"和"实时推送"

### P2 — 测试矩阵

| 测试 | 预期 |
|------|------|
| Summary: CC user_prompt | data 仅含 `{type, summary, summaryShort}`，summary = `"User prompt"` |
| Summary: CC task_complete | data 仅含 `{type, summary, summaryShort}`，summary = `"Task completed"` |
| Summary: Codex error | data 非空，含 status，不含原始 message |
| Summary: OpenCode idle task_complete | data 走安全化，summary = `"Task completed"` |
| Off: CC 不发 transcript/task_complete | checkHistoryPolicy → allowed: false → return |
| Off: Codex 不发 history event | ContentPolicy='enforce' → policy.allowed: false → return |
| Off: OpenCode 不发 idle/error | projectHistoryEventForPolicy → 拒绝 |
| Off: approval_required 仍发送 | approval-exempt 路径通过，含 command/summary |
| Off: phone command 仍发送 | phone-originated 路径通过，含 prompt |
| Full: 所有事件全文 | policy.recent → 不投影 |

---

## 四、不做

- relay 端事件删除
- per-session 策略
- 审批事件 secret scan/blocklist 改动（保留现有逻辑）
