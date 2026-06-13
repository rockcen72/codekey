# Event Share / History Policy 功能测试计划

> 日期: 2026-06-12  
> 修订: 2026-06-13  
> 版本: 1.1.1  
> 范围: VS Code 侧边栏事件共享策略、手机端历史可见性、后端 API 隐私验收  
> 原则: 普通测试步骤必须是用户能直接操作的 UI 行为；内部 API / mock relay 只放在“开发者验证”章节。

---

## 当前功能口径

侧边栏目前提供的是 **agent 级事件共享策略**，不是 per-session 策略。

| UI 文案 | 内部值 | 含义 |
|---|---|---|
| Off / 关闭 | `off` | 不同步历史事件到手机；审批请求仍正常推送 |
| Full / 会话过程 | `recent` | 同步最近一段会话事件；仍经过 privacy pipeline |
| Summary / 任务摘要 | `sanitized` | 只同步安全摘要/状态等投影字段，不同步原始 prompt/output |

当前限制:

- 没有 recentCount 输入框；数量使用内部默认值。
- 没有 per-session 策略 UI；只支持 Claude Code、Codex、OpenCode 三个 agent 级下拉。
- 没有 Reset All 按钮；恢复默认值时逐个把三个下拉改成 Off。
- Minimal 策略未在 UI 暴露，当前不测。
- Direct API 验收需要 token，不要求普通用户执行。

---

## 测试环境

### 必备

1. 安装最新 VSIX，例如 `packages/vscode/codekey-vscode-1.1.1.vsix`。
2. VS Code 打开一个真实工作区。
3. 打开 CodeKey 侧边栏，手机端已配对并显示已连接。
4. 手机端使用微信小程序；如要验证 Telegram，再额外打开 Telegram Mini App。
5. 三个 agent 至少准备其中一个可运行；完整回归建议都准备:
   - Claude Code
   - Codex
   - OpenCode

### 建议打开的观察窗口

1. VS Code Output 面板，选择 `CodeKey`。
2. 手机端 session 列表页。
3. 手机端 session 详情页。

---

## 普通测试用例

### TC-01: 侧边栏展示事件共享卡片

| 步骤 | 用户操作 | 预期 |
|---|---|---|
| 1.1 | 打开 VS Code 左侧 CodeKey 侧边栏 | 能看到 `Event Share` / `事件共享` 卡片 |
| 1.2 | 查看卡片内容 | 有三行: Claude Code、Codex、OpenCode |
| 1.3 | 查看每行下拉 | 每个下拉都有 Off / Full / Summary 三个选项 |
| 1.4 | 首次安装或清空配置后查看默认值 | 三个下拉默认是 Off / 关闭 |

通过标准: 卡片可见、选项齐全、无空白/错位/按钮文字溢出。

---

### TC-02: Off 不影响审批请求

| 步骤 | 用户操作 | 预期 |
|---|---|---|
| 2.1 | 在事件共享卡片中，把 Claude Code 改为 Off | 下拉保持 Off |
| 2.2 | 在 Claude Code 中触发一次需要审批的动作，例如写文件或运行高风险命令 | 手机收到审批卡 |
| 2.3 | 在手机上点击批准或拒绝 | 桌面端 agent 收到结果并继续执行或停止 |
| 2.4 | 回到手机 session 列表 | 不应因为 Off 自动出现完整历史会话 |

通过标准: Off 只限制历史同步，不影响审批链路。

---

### TC-03: Full 显示会话过程

| 步骤 | 用户操作 | 预期 |
|---|---|---|
| 3.1 | 在事件共享卡片中，把 Claude Code 改为 Full / 会话过程 | 下拉保持 Full |
| 3.2 | 启动或继续一个 Claude Code 会话，发送一条普通 prompt，例如 `say hello from codekey test` | 桌面端 agent 正常回复 |
| 3.3 | 打开手机 session 列表，必要时下拉刷新 | 能看到对应 Claude Code session |
| 3.4 | 进入 session 详情 | 能看到用户 prompt 和 agent 输出 |
| 3.5 | 检查消息方向 | 用户输入显示在右侧，agent 输出显示在左侧 |

通过标准: Full 下手机端能看见会话过程，且用户/agent 消息方向正确。

---

### TC-04: Summary 只显示任务摘要

| 步骤 | 用户操作 | 预期 |
|---|---|---|
| 4.1 | 在事件共享卡片中，把 Codex 改为 Summary / 任务摘要 | 下拉保持 Summary |
| 4.2 | 启动或继续一个 Codex 会话 |
| 4.3 | 发送含唯一标记的 prompt，例如 `CODEKEY_RAW_PROMPT_MARKER_001 summarize only` | 桌面端 Codex 正常执行 |
| 4.4 | 打开手机端对应 session 详情 | 能看到任务状态/摘要类事件 |
| 4.5 | 在手机端肉眼检查事件内容 | 不应出现完整 prompt 原文 `CODEKEY_RAW_PROMPT_MARKER_001` |

通过标准: Summary 下可看进度，但不泄露原始 prompt/output。

---

### TC-05: Off 与 Summary / Full 切换即时生效

| 步骤 | 用户操作 | 预期 |
|---|---|---|
| 5.1 | 把 Codex 设置为 Full，产生一条新会话事件 | 手机端能看到 Codex session |
| 5.2 | 把 Codex 改回 Off | 下拉保持 Off |
| 5.3 | 等待 5-15 秒，刷新手机 session 列表 | 后续 Codex 历史事件不再新增 |
| 5.4 | 再把 Codex 改为 Summary | 后续新事件以摘要形式出现 |
| 5.5 | 再把 Codex 改为 Full | 后续新事件能显示更完整内容 |

通过标准: 策略变化不需要重启 VS Code；后续事件按新策略处理。

说明: 已经同步到 relay 的旧事件是否立即从旧页面消失，以后端 API 验收为准，不只看 UI 缓存。

---

### TC-06: OpenCode 会话策略

| 步骤 | 用户操作 | 预期 |
|---|---|---|
| 6.1 | 把 OpenCode 设置为 Off | 下拉保持 Off |
| 6.2 | 运行一个 OpenCode 任务 | 手机端不出现新的 OpenCode 历史事件 |
| 6.3 | 把 OpenCode 改为 Full | 下拉保持 Full |
| 6.4 | 再发送一条 OpenCode prompt | 手机端能看到 OpenCode session 和后续事件 |
| 6.5 | 进入详情页 | 用户输入在右侧，agent 输出在左侧 |

通过标准: OpenCode 与 Claude/Codex 采用同一策略语义。

---

### TC-07: 侧边栏 session detail view

| 步骤 | 用户操作 | 预期 |
|---|---|---|
| 7.1 | 任一 agent 设置为 Full，并产生可见 session | 侧边栏本地会话列表出现对应会话 |
| 7.2 | 点击会话标题 | 侧边栏切换到 detail view |
| 7.3 | 查看 detail view | 能看到 session 标识和事件列表 |
| 7.4 | 检查事件类型 | 常见类型如 `user_prompt`、`task_complete`、`approval_required`、`command_started` 能正常显示 |
| 7.5 | 点击 Back / 返回 | 回到本地会话列表 |

通过标准: 侧边栏 detail view 可进入、可返回、不会让同步按钮或 agent tab 消失。

---

### TC-08: 策略持久化

| 步骤 | 用户操作 | 预期 |
|---|---|---|
| 8.1 | 设置三项策略: Claude Code=Off, Codex=Full, OpenCode=Summary | 三个下拉显示对应值 |
| 8.2 | 执行 `Developer: Reload Window` | VS Code 窗口重载 |
| 8.3 | 再打开 CodeKey 侧边栏 | 三个下拉仍显示之前的值 |
| 8.4 | 完全关闭 VS Code 后重开 | 扩展重新激活 |
| 8.5 | 再打开 CodeKey 侧边栏 | 策略仍能回显 |

通过标准: 策略不会因为 reload 或重启 VS Code 丢失。

---

## 发布前 API 验收

这些用例用于确认“绕过 UI 也不能读到不该读的数据”。需要测试人员能拿到 token 或开发者协助执行。

### Token 准备

WeChat 小程序使用 `clientToken` 调用 device API:

```bash
BASE=https://codekey.tinymoney.cn/api/v1
CLIENT_TOKEN=<从小程序本地存储 CODEKEY_CLIENT_TOKEN 取得>
```

Telegram Mini App / 用户视角 API 使用 `user_token`:

```bash
BASE=https://codekey.tinymoney.cn/api/v1
USER_TOKEN=<从 Telegram Mini App sessionStorage 或登录流程取得>
```

如果拿不到 token，跳过本章节，只跑普通 UI 测试。

---

### API-01: Off 后不能通过 list 看到 session

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | UI 中把 Codex 设置为 Full，并产生一个 Codex session | 手机列表能看到 session |
| 2 | 调用 list API，记录该 `sessionId` | 返回 200，列表中包含该 session |
| 3 | UI 中把 Codex 改为 Off，等待 15 秒 | 策略同步完成 |
| 4 | 再调用 list API | 返回 200，但列表中不包含该 `sessionId` |

WeChat/device API:

```bash
curl -s "$BASE/sessions?history=1" -H "Authorization: Bearer $CLIENT_TOKEN"
```

Telegram/user API:

```bash
curl -s "$BASE/user/sessions?history=1" -H "Authorization: Bearer $USER_TOKEN"
```

通过标准: Off 后 list 不再暴露该历史 session。

---

### API-02: Off 后旧 sessionId 不可枚举

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | 复用 API-01 记录的旧 `sessionId` | 有旧 sessionId |
| 2 | Codex 保持 Off | 策略为 Off |
| 3 | 直接请求 detail API | 应返回 404 |
| 4 | 直接请求 events API | 应返回 404 |

WeChat/device API:

```bash
curl -i "$BASE/sessions/$SESSION_ID" -H "Authorization: Bearer $CLIENT_TOKEN"
curl -i "$BASE/sessions/$SESSION_ID/events" -H "Authorization: Bearer $CLIENT_TOKEN"
```

Telegram/user API:

```bash
curl -i "$BASE/user/sessions/$SESSION_ID" -H "Authorization: Bearer $USER_TOKEN"
curl -i "$BASE/user/sessions/$SESSION_ID/events" -H "Authorization: Bearer $USER_TOKEN"
```

通过标准: Off 后直接访问旧 ID 也不能读历史；返回 404，而不是 200 + 空数组。

---

### API-03: Summary 响应不含原文

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | UI 中把 Codex 设置为 Summary | 策略为 Summary |
| 2 | 产生包含唯一 marker 的 prompt: `CODEKEY_SECRET_MARKER_001` | 桌面端执行正常 |
| 3 | 调用 events API | 返回 200 |
| 4 | 搜索响应 JSON | 不包含 `CODEKEY_SECRET_MARKER_001`、token、完整路径、命令输出原文 |
| 5 | 检查 `events[].data` | 只包含摘要/状态/metadata/basename 等安全字段 |

示例:

```bash
curl -s "$BASE/sessions/$SESSION_ID/events" \
  -H "Authorization: Bearer $CLIENT_TOKEN" > events.json

Select-String -Path events.json -Pattern "CODEKEY_SECRET_MARKER_001|sk-|ghp_|C:\\\\Users|F:\\\\Work"
```

通过标准: Summary 响应不能含原文 marker 或敏感路径/token。

---

### API-04: 非法策略值被拒绝

该用例验证 bridge 本地 API，不需要手机 token。先从 VS Code Output 里确认 bridge 端口，或从 CodeKey 日志中找到 `Bridge listening` 的本地地址。

```bash
BRIDGE=http://127.0.0.1:<bridge-port>
```

| 步骤 | 操作 | 预期 |
|---|---|---|
| 1 | PUT 一个非法 policy | 返回 400 |
| 2 | 重新打开侧边栏 | UI 没有变成非法值 |

示例:

```bash
curl -i -X PUT "$BRIDGE/v1/history-policy" \
  -H "Content-Type: application/json" \
  -d '{"key":"codex","config":{"policy":"invalid","updatedAt":1}}'
```

通过标准: 返回 400，策略保持原值。

---

## 开发者兼容性验证

### DEV-01: 旧 relay / mock relay 兼容

这个用例不要求普通测试人员执行。目标是确认客户端遇到不支持 history policy 的 relay 时不会崩溃。

| 模式 | 操作 | 预期 |
|---|---|---|
| 404 | mock relay 对 history policy API 返回 404 | 侧边栏仍可打开，策略默认 Off，Output 记录失败 |
| timeout / ignore | mock relay 丢弃请求 | 侧边栏不崩溃，不出现重连风暴 |
| broken | mock relay 返回 500 或断开 WS | 审批/命令基础功能恢复到真实 relay 后可用 |

注意: 默认测试不替换生产 relay。需要本地 mock 时，使用本地配置或临时环境变量指向 mock 地址，测完恢复真实 relay。

---

### DEV-02: Recent 数量边界

当前 UI 没有 recentCount 输入框，因此边界值通过 bridge API 或单元测试验证。

| 输入 | 预期 |
|---|---|
| `recentCount=1` | 接受 |
| `recentCount=50` | 接受 |
| `recentCount=0` | fallback 到默认值 |
| `recentCount=51` | fallback 到默认值 |
| `recentCount=3.7` | fallback 到默认值 |
| `recentCount="abc"` | fallback 到默认值 |

优先用单元测试覆盖 `sanitizeRecentCount`；UI 测试不测这些值。

---

## 回归清单

| 编号 | 验证项 | 操作 | 预期 |
|---|---|---|---|
| R1 | Claude 审批 | Claude Code 触发文件写入或命令审批 | 手机收到审批卡 |
| R2 | 审批响应 | 手机点击批准/拒绝 | 桌面端收到结果 |
| R3 | 手机发 prompt | 在手机 session 详情底部输入 prompt | 桌面端 agent 收到并执行 |
| R4 | 用户消息方向 | 手机详情页查看刚发送的 prompt | 用户消息在右侧 |
| R5 | 取消同步按钮 | 侧边栏点击已同步 session 的取消同步 | 不长时间卡 spinner，不显示“完成”状态 |
| R6 | 重新同步 | 取消同步后再点同步 | 能恢复同步，agent tab 不消失 |
| R7 | README 图片 | 安装 VSIX 后打开扩展详情页 | 三张介绍图同排显示且不破图 |
| R8 | Telegram 基础 | Telegram Mini App 登录并打开 sessions | 可加载绑定设备和会话列表 |

---

## 发布门槛

必须通过:

- TC-01 至 TC-08
- API-01 至 API-03
- R1 至 R7

建议通过:

- API-04
- DEV-01
- DEV-02
- R8

---

## 已知限制

- 当前策略是 agent 级，不是 session 级。
- Summary 的验收重点是“不暴露原文”，不是摘要文本必须完整表达任务。
- UI 没有 recentCount 输入框，数量边界只通过单元测试或开发者 API 验证。
- 手机端可能有短时间缓存；涉及隐私不可枚举时，以 Direct API 验收为准。
