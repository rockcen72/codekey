# Approval Card Sidebar — 渲染解耦与错误降级修复

日期: 2026-06-07
状态: 已审核，待实施

### 补充发现: Unsync 按钮状态不更新

**根因**: CC 会话 `attached` 状态没有 `_isRecentlyDetached` 本地覆盖（与 OpenCode/Codex 不一致）。`_pushStateInner()` 依赖 relay API，失败时 catch 块只推审批数据不推 session 状态。

**修复**: `sidebar-provider.ts:724` 加 `&& !this._isRecentlyDetached(s.sessionId)`

### 审核结论

| 方案 | 评价 | 说明 |
|------|------|------|
| 1. `_pollBridgeApprovals` 直接渲染 | ✅ 必改 | 根因正确，提取 `_buildApprovalState()` 消除重复 |
| 2. 修复 `_pushStateApprovalsOnly` 结构 | ✅ 必改 | `type: 'update'`→`'stateUpdate'` + `payload` 嵌套 → 平铺 |
| 3. 404 降级提前到首次 | ✅ 建议 | 已有 5 次逻辑，只需把 `_bridgeSupportsPendingApprovals = false` 提出来 |
| 4. 超时 5s→3s | ✅ 可选 | 减小 `_pushInFlight` 阻塞窗口 |

---

## 问题

CC 和 Codex 审批卡在侧边栏中不显示/延迟消失。根因不是 hook 事件链路，而是 sidebar UI 的渲染流程依赖了一个不稳定的外部依赖。

### 当前流程

```
_pollBridgeApprovals(1s) → GET /v1/pending-approvals ✅
  → _pushState() → _pushStateInner() → relay API(s) [secure-fetch, 5s 超时]
                                        ↓ (超时/失败)
                                       throw
                                        ↓
                                      catch → _pushStateApprovalsOnly()
                                                ↓ (bug)
                                              type: 'update' 应 'stateUpdate'
```

- `_bridgeApprovals` 数据已从 bridge HTTP 正确拿到（内存中）
- 但渲染必须经过 `_pushStateInner()`，它还会调 relay API（会话列表、设备状态等）
- relay 网络不稳定时（`[secure-fetch] TLS error…aborted`），`_pushStateInner` 抛异常
- catch 块调用 `_pushStateApprovalsOnly()` 试图只推审批数据
- 但 `postMessage` 类型为 `'update'`，WebView handler 只认 `'stateUpdate'`，数据被静默丢弃

### 消失路径

| 路径 | 方式 | 可靠性 |
|------|------|--------|
| 手机批准 | `approval_forward` WS → `pendingByServerEventId.delete()` → 1s 轮询 | ✅ 即时 |
| 侧边栏批准 | `/v1/approval-response` → 本地 emit → 同上 | ✅ 即时 |
| `task_complete` hook | `resolvePendingApprovalsForSession()` | ✅ 兜底 |
| 30min 超时 | timer auto-reject | ✅ 兜底 |

消失路径本身正确，问题仅在于 UI 渲染被 relay 依赖阻塞。

---

## 修复方案

### 1. [必改] `_pollBridgeApprovals` 直接发 `stateUpdate`（解耦）

不再经过 `_pushState()` → `_pushStateInner()`，拿到 approval 数据后直接渲染。

**文件**: `packages/vscode/src/webview/sidebar-provider.ts`

```typescript
// _pollBridgeApprovals 末尾 — 拿到 _bridgeApprovals 后直接推给 WebView
if (this._view) {
  const state = this._buildApprovalState();
  this._view.webview.postMessage({
    type: 'stateUpdate',
    approvalsHtml: renderApprovalsContent(state),
    approvalCount: state.pendingApprovals.length,
  });
}
```

需要提取 `_buildApprovalState()` 方法，复用 `_pushStateInner` 中构建 `pendingApprovals` 数组的逻辑（两份逻辑目前已不同步）。

**改动点**:
- 从 `_pushStateInner` 中提取 approvals 构建逻辑为独立方法
- `_pollBridgeApprovals` 拿到新 approvals 后调用该方法 → `postMessage`
- `_pushStateInner` 中的 approvals 分支（`this._bridgeApprovals` 源）复用同一方法

### 2. [必改] 修复 `_pushStateApprovalsOnly` 消息类型 + payload 结构

`_pushStateApprovalsOnly` 有两种问题，不是 1 行改动：

**文件**: `packages/vscode/src/webview/sidebar-provider.ts ~line 414`

```diff
 this._view.webview.postMessage({
-  type: 'update',                    // bug 1: 应为 'stateUpdate'
+  type: 'stateUpdate',
-  payload: {                         // bug 2: 多了一层 payload 包装
-    approvals: renderApprovalsContent({...}),
-    _approvalsCount: ...,
-  },
+  approvalsHtml: renderApprovalsContent({...}),
+  approvalCount: ...,
 });
```

正常的 `_pushStateInner` 结构:
```
{ type: 'stateUpdate', approvalsHtml: string, approvalCount: number, ... }
```

WebView handler 读 `e.data.approvalsHtml`，所以 payload 嵌套导致该字段为 undefined。

### 3. [建议] 404 降级提前到首次

当前代码（line 170-178）：
1. 第一次非 200 → `_approvalPoll404Count = 1`，继续用 `_bridgeSupportsPendingApprovals = true`
2. 第 5 次 → 切 `false`，30s 后重试切回 `true`

改为首次非 200 就降级，保留计数用于重试：

```diff
+ this._bridgeSupportsPendingApprovals = false;
  if (++this._approvalPoll404Count >= 5) {
    ...
-   this._bridgeSupportsPendingApprovals = false;
  }
```

这样 bridge 不可用时 1s 内即可切到 bridge 直读路径（方案 4），不等 5s。

### 4. [建议] relay API 超时 5s → 3s

**文件**: `packages/vscode/src/util/secure-fetch.ts`

5s 等待 TLS 握手 + HTTP 请求 = 挂起 `_pushState` 互斥锁太久。

改为 3s 减少对渲染流水线的阻塞。

---

## 实施顺序

1. 修复消息类型（方案 2）— 1 行改动，立即可用
2. `_pollBridgeApprovals` 直接推渲染（方案 1）— 核心解耦
3. 404 立即降级（方案 3）— 配合方案 1 效果更佳
4. 超时 5s→3s（方案 4）— 无关紧要的优化

---

## 验证

1. 启动 CC/Codex 会话，触发审批 → 侧边栏 1s 内显示审批卡
2. 在 DevTools Network 模拟 relay 超时 → 审批卡仍显示
3. 手机/侧边栏批准/拒绝 → 侧边栏即时更新（1s 内消失）
4. `task_complete` hook 触发 → 相关审批卡消失
5. 多次审批 → 无累积、无幽灵卡

---

## 不做的

- **不改为全推模式**（bridge stdout 推送审批状态）— 当前 HTTP 轮询足够可靠，且改动量小
- **不涉及 bridge/relay 服务端改动** — 问题出在 sidebar 渲染架构，不是数据传输通道
- **不触碰 phone 小程序的审批卡** — 它通过 WS 接收 `event_resolved` 事件，不受影响
