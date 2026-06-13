# HistorySharePolicy 功能测试计划

> 日期: 2026-06-12
> 版本: 1.1.0
> 测试范围: 历史共享策略 + 侧边栏 detail view + 后端 API 隐私验证
> 前置条件: 安装 VSIX 1.1.0（已打包）；一台配对手机（小程序）；PC 端各 agent 有历史会话

---

## 测试环境搭建

1. 安装 `codekey-vscode-1.1.0.vsix`（vsix from packages/vscode/）
2. 手机微信打开小程序，确认配对状态
3. 准备三个 agent 的历史数据：
   - Claude Code: `~/.claude/sessions/` 有至少 2 个 session
   - Codex: `~/.codex/sessions/` 有至少 2 个 session
   - OpenCode: 有至少 1 个 session
4. 确认 VS Code Output → `CodeKey` 频道可见 `=== CodeKey activating ===`
5. Mock relay（TC-13 需要）：`node scripts/mock-relay.js`

---

## 测试用例

### TC-01: 侧边栏呈现 History Policy 卡片

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 1.1 | 打开 CodeKey 侧边栏 | 可见 History Sharing Policy 卡片，位置在 Privacy Settings 和 Subscribe 之间 |
| 1.2 | 观察下拉行 | 三行存在：Claude Code、Codex、OpenCode，各有一个 `<select>` |
| 1.3 | 检查默认值 | 每个下拉选项默认为 Off，recentCount input 不存在 |
| 1.4 | 任选一个 agent 下拉 → 选 Recent（无确定按钮，选完立即触发） | Output 面板出现 `PUT /v1/history-policy` 日志 |

**验证方法**: 目视 + Output 面板日志

---

### TC-02: 设置单 Agent 策略为 Recent

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 2.1 | 侧边栏 → Claude Code 下拉 → 选 Recent（无确定按钮，改下拉即触发） | `<select>` 旁边出现 recentCount `<input>`，默认值 10 |
| 2.2 | 修改数量为 5（改输入框即触发） | Output: `PUT /v1/history-policy {key:"claude-code-hook", config:{policy:"recent", recentCount:5}}` |
| 2.3 | 刷新侧边栏（关闭再打开） | Claude Code 行仍显示 Recent / 5 |

**验证方法**: Output 面板 + 刷新后回显

---

### TC-03: Sanitized 策略 + 敏感内容验证

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 3.1 | 侧边栏 → Codex 下拉 → 选 Sanitized | `<select>` 旁出现 recentCount 输入（默认 10），无额外字段 |
| 3.2 | 选「更新配置」 | bridge PUT 到 relay |
| 3.3 | 构造含敏感内容的会话：依次发送包含以下内容的 prompt/命令:<br>• API key: `sk-abc123...`<br>• token: `ghp_xxxxxxxxxxxx`<br>• 手机号: `13800138000`<br>• .env 路径: `F:\Work\secret\.env`<br>• Windows 绝对路径: `C:\Users\admin\Documents\passwords.txt`<br>• 完整命令输出（多行） | 所有事件均已到达 relay（Sanitized 允许 forward） |
| 3.4 | 手机端查看 session 详情 | 事件可见，`payload.data` 只含 `{summary, metadata, status, basename}` |
| 3.5 | 搜索手机端所有可见文本 | **不得出现**: `sk-abc123`, `ghp_`, `13800138000`, `F:\Work\secret`, `passwords.txt`, 完整命令输出原文 |
| 3.6 | 通过 HTTP API 获取同一 session 的事件 | events 响应与手机端一致（同样脱敏） |
| 3.7 | 确认 approval_required 事件的 `data` 中 `command` 字段 | 该字段走 desensitize()，不含敏感原文 |
| 3.8 | 恢复 Off: 下拉选 Off，更新配置 | Codex 行回到 Off，手机端 Codex session 不再可见 |

**验证方法**: 手机端 + 直接 HTTP API

---

### TC-04: 策略默认值（Off）—— 手机不可见

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 4.1 | 确保三 agent 策略均为 Off | 侧边栏每行显示 Off |
| 4.2 | 手机端打开 CodeKey 小程序 | session 列表为空或只显示未被策略过滤的公共事件 |
| 4.3 | PC 端 CC 发起一次审批请求 | 手机收到 PermissionRequest，OK 之后 |
| 4.4 | 手机端再次检查 session 列表 | session 仍不在列表中（因为 Off） |

**验证方法**: 手机端目视

---

### TC-05: Minimal 策略（已从 UI 移除，待实现）

> **注解**: Minimal 当前实现同 Off（`{allowed: false}`），已从侧边栏下拉选项中移除。后续实现真正的"最小共享"语义后需恢复 UI + 重写此用例。

---

### TC-06: 初始推送（attach 时自动发策略）

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 6.1 | 设 CC 策略为 Recent/5 | 已保存 |
| 6.2 | 退出 CC 再启动 CC（触发新的 attach） | Output: `pushHistoryPolicyToRelay: key=claude-code-hook` 日志出现 |
| 6.3 | 手机端查看该 session | 策略生效，session 可见，事件按 Recent-5 裁剪 |

**验证方法**: Output 日志 `pushHistoryPolicyToRelay` + 手机端

---

### TC-07: 侧边栏 Session Detail View

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 7.1 | 策略设为 Recent/10 | 手机端会产生多个事件 |
| 7.2 | 侧边栏 session 列表中，点击一个 session 行 | 侧边栏切换到 detail view：显示 session ID + 事件列表，每行有 eventType + timestamp |
| 7.3 | 检查事件类型 | 包含：🔵 user_prompt、✅ task_complete、🟡 approval_required、▶️ command_started |
| 7.4 | 点「← Back」按钮 | 返回 session 列表，状态恢复 |
| 7.5 | 切换策略到 Off | 等 2 秒 → 列表自动刷新，该 session 消失 |

**验证方法**: 侧边栏目视

---

### TC-08: Codex session click → detail view

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 8.1 | Codex 策略设为 Recent/10 | 有事件产生 |
| 8.2 | 侧边栏找到 Codex session（显示 serverSessionId 的条目） | 可识别，与 CC session 并列 |
| 8.3 | 点击该 Codex session 行 | 跳转到 detail view，显示 Codex 相关事件 |
| 8.4 | 验证 events 包含 Codex 特有 eventType | 如 `task_complete` |

**验证方法**: 侧边栏目视

---

### TC-09: 策略持久化（拆四个场景）

#### 9a: Bridge 进程重启

| 步骤 | 操作 | 预期 |
|------|------|------|
| 设置三 agent 为不同策略: CC=Off, Codex=Recent/3, OC=Sanitized | 保存成功 |
| 用任务管理器 / kill 杀掉 bridge 子进程 | VS Code 扩展自动重启 bridge |
| 打开侧边栏 | 三行的策略从 relay 或内存重新加载，回显正确 |
| 手机端 | Codex session 可见（Recent/3），OC 可见（Sanitized） |

#### 9b: VS Code 完全重启

| 步骤 | 操作 | 预期 |
|------|------|------|
| 全关 VS Code → 重新打开 | 扩展重新激活 |
| 打开侧边栏 | 三行策略从 relay 回显：CC=Off, Codex=Recent/3, OC=Sanitized |
| 手机端检查 | Codex session 可见（受 Recent/3 限制），OC session 可见（受 Sanitized） |

#### 9c: 手机离线时重启

| 步骤 | 操作 | 预期 |
|------|------|------|
| 手机断网或关闭小程序 | bridge 与 relay 连接保持 |
| kill bridge → 自动重启 | 侧边栏策略回显同 9a（同步可能失败但 bridge 不 crash） |
| 手机恢复网络 | 策略同步，手机端可见性正确 |

#### 9d: Relay 重启后重连

| 步骤 | 操作 | 预期 |
|------|------|------|
| SSH 重启 relay 服务 | bridge WS 断连 → 自动重连 |
| 重连后侧边栏操作 | 策略 CRUD 正常 |
| 手机端 | session 可见性正确 |

#### 9e: 删除所有策略

| 步骤 | 操作 | 预期 |
|------|------|------|
| 侧边栏点 Reset All | 三行回到 Off |
| 刷新 | 全部 Off |

**验证方法**: 各场景独立验证

---

### TC-10: 策略与审批流程联动

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 10.1 | CC 策略为 Off | |
| 10.2 | CC 发起一次文件写入审批 | 手机收到 PermissionRequest |
| 10.3 | 手机端批准 | CC 继续执行 |
| 10.4 | 等待 syncClaudeTranscript 一轮 | 手机端 session 列表仍为空（Off 策略） |
| 10.5 | 切到 Recent/20 | 等待 syncClaudeTranscript |
| 10.6 | 手机端再次查看 | session 出现，含刚才批准后的 transcript 事件 |

**验证方法**: 策略切换前后对比

---

### TC-11: OpenCode session 策略门控

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 11.1 | OpenCode 策略为 Off | |
| 11.2 | 运行一个 OpenCode 任务（直至完成 or 出错） | 手机端无 OC 事件 |
| 11.3 | 切到 Recent/10 | |
| 11.4 | 相同 OC 任务的后继事件 | 手机端可见 |

**验证方法**: 手机端

---

### TC-12: Wildcard (`*`) 兜底

| 步骤 | Agent 动作 | 预期 |
|------|-----------|------|
| 12.1 | 只设置 `*` 策略为 Recent/5，各 agent 不设 | 通过 WS 或 API 添加 |
| 12.2 | 等待 sync 周期 | 三 agent 都受 Recent/5 约束（事件裁剪到 5 条） |
| 12.3 | 设置 Codex 为 Off（覆写 `*`） | Codex 不可见，CC/OC 仍 Recent/5 |
| 12.4 | 删除 Codex 配置 | Codex 回到 `*` 兜底 = Recent/5 |

**验证方法**: 手机端

---

### TC-13: 旧 Relay 兼容 - Mock Relay

**验证环境**: `scripts/mock-relay.js`，本地运行，不碰远程 relay。

Mock 分三模式，依次测试：

| 步骤 | 操作 | 预期 |
|------|------|------|
| 13.1 | `node scripts/mock-relay.js --mode=404`，bridge 指向 `http://localhost:9999` | VS Code 扩展不崩溃 |
| 13.2 | 打开侧边栏 | History Policy 卡片正常渲染，显示默认 Off |
| 13.3 | 调用 `GET /v1/history-policies` | mock 返回 404，侧边栏显示空策略 / 默认 Off |
| 13.4 | 点击 Create/Update Policy | `PUT /v1/history-policy` 返回 404，Output 记录失败但 bridge/sidebar 不崩溃 |
| 13.5 | mock WS 收到 `sync_history_policy` 后被拦截 | bridge 不重连风暴、不 crash |
| 13.6 | 恢复真实 relay | 审批、命令转发、session 基础功能恢复正常 |
| 13.7 | 重复 13.1-13.6 用 `--mode=ignore` | HTTP 超时 + WS 丢弃不导致 bridge 崩溃 |
| 13.8 | 重复 13.1-13.6 用 `--mode=broken` | 500 / 乱码 / WS 断开不导致 bridge 崩溃 |

**验收标准**: 不支持 history policy 的旧 relay 场景下，客户端降级为 Off/不可用状态；审批、命令转发、session 基础功能不受影响。

---

### TC-14: 绕过 UI 的后端隐私验证（Direct API）

**验证后端**: relay mobile/device HTTP API，不以小程序 UI 为判据。

覆盖接口：

- WeChat/device token 路径：
  - `GET /api/v1/sessions?history=1`
  - `GET /api/v1/sessions/:id`
  - `GET /api/v1/sessions/:id/events`
- Telegram/user token 路径：
  - `GET /api/v1/user/sessions?history=1`
  - `GET /api/v1/user/sessions/:id`
  - `GET /api/v1/user/sessions/:id/events`

| 步骤 | 操作 | 预期 |
|------|------|------|
| 14.1 | 设置 Codex = Recent/10，产生一条包含唯一 marker 的历史，如 `CODEKEY_SECRET_MARKER_001` | 手机列表可见该 session |
| 14.2 | 直接调用 sessions list API，记录 `sessionId` | 返回 200，列表包含该 session |
| 14.3 | 直接调用 detail/events API | 返回 200，events 中能看到该 session 的历史事件 |
| 14.4 | 切换 Codex = Off，等待最多 15s 或 2 个 sync cycle | 策略已同步到 relay |
| 14.5 | 再调用 sessions list API | 返回 200，但列表不包含该 `sessionId` |
| 14.6 | 用旧 `sessionId` 直接调用 detail API | 返回 **404**（不是空对象，不是 200） |
| 14.7 | 用旧 `sessionId` 直接调用 events API | 返回 **404**（不是空数组，不是 200） |
| 14.8 | 期间触发 PermissionRequest | 手机仍能收到审批弹窗，但该 session 不能作为历史出现在 list/detail/events |

**验收标准**: Off 后旧 sessionId 不能通过任何 mobile/user HTTP API 读取历史；不能返回脱敏历史，也不能返回空 events 暗示 session 存在。404 做不可枚举语义。

---

### TC-15: Sanitized 后端脱敏验证（Direct API）

| 步骤 | 操作 | 预期 |
|------|------|------|
| 15.1 | 设置 Codex = Sanitized/10，产生包含 token、路径、prompt 原文的历史 | session 可见 |
| 15.2 | 直接调用 events API | 返回 200 |
| 15.3 | 检查 `events[].data` | 只包含 `summary`, `metadata`, `status`, `basename` |
| 15.4 | 搜索响应 JSON | 不包含 prompt 原文、完整路径、token、命令 output 原文 |
| 15.5 | 跨接口验证: events API 与 WS event_push 返回 | 一致 |

**验收标准**: Sanitized 只暴露投影字段；不得含有 user_prompt 原文、assistant output、命令 input、路径、token 等敏感信息。

---

### TC-16: Recent 边界测试

| 步骤 | 操作 | 预期 |
|------|------|------|
| 16.1 | 设置 Codex = Recent/1 | 有效：只同步最近 1 条事件 |
| 16.2 | 手机端检查 | 只有 1 条事件可见 |
| 16.3 | 设置 Codex = Recent/50 | 有效：同步最近 50 条 |
| 16.4 | 手机端检查 | 最多 50 条事件（如果历史不足 50 条则全部可见） |
| 16.5 | 设置 Codex = Recent/0（通过 API 或手动构造） | 自动 clamp 到默认值 10（`sanitizeRecentCount`） |
| 16.6 | 设置 Codex = Recent/51 | 自动 clamp 到 10（超出 MAX_RECENT_COUNT） |
| 16.7 | 设置 Codex = Recent/3.7（浮点数） | clamp 到默认值 10（非整数） |
| 16.8 | 设置 Codex = Recent/"abc"（字符串） | clamp 到默认值 10 |
| 16.9 | 验证排序: 确认 events 按 `created_at` 或 `ts` 降序取前 N 条，非 transcript 文件中的出现顺序 | 事件符合文档约定的排序规则 |

**验证方法**: 手机端 + 直接 API

---

## 回归验证

| # | 验证项 | 命令 / 操作 |
|---|--------|-------------|
| R1 | CC PermissionRequest 正常到达手机 | 手机收到弹窗 |
| R2 | 手机批准 → PC 正常执行 | 命令完成 |
| R3 | 手机发送命令 → PC 执行 | `say hello` 在 CC 终端输出 |
| R4 | 小程序 session 列表正常 | 可见 |
| R5 | Telegram Bot 配对 | 可用 |
| R6 | 关闭 CC → 重开 CC | bridge 恢复 session |

---

## 验收标准

**P0（必须通过）**: TC-01, TC-02, TC-03, TC-04, TC-07, TC-09, TC-14, TC-15
**P1（必须通过）**: TC-06, TC-10, TC-12, R1, R2, R3, R4
**P2（建议通过）**: TC-05, TC-08, TC-11, TC-13, TC-16, R5, R6

---

## 已知限制

- Minimal 当前实现等价于 Off 且已从 UI 移除；真正的最小共享语义待后续实现
- per-session 策略 UI 未实现（仅 agent-level + wildcard）
- 策略变更在 bridge 侧是近乎即时的（按 sync cycle），非 push 实时生效
- 旧 relay 兼容测试通过本地 mock relay 完成（`scripts/mock-relay.js`）
