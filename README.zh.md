<div align="center">

# CodeKey

**AI 编程远程遥控器 — 手机上审批、拒绝、回复**

<p align="center">
  <a href="README.md">🇺🇸 English</a>
</p>

<br />

<a href="https://marketplace.visualstudio.com/items?itemName=codekey.codekey-vscode"><img src="https://img.shields.io/visual-studio-marketplace/v/codekey.codekey-vscode?label=VS%20Code&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" /></a>
<a href="https://marketplace.visualstudio.com/items?itemName=codekey.codekey-vscode"><img src="https://img.shields.io/visual-studio-marketplace/d/codekey.codekey-vscode?label=Downloads&logo=visualstudiocode&logoColor=white" alt="Downloads" /></a>
<a href="https://github.com/rockcen72/codekey"><img src="https://img.shields.io/github/stars/rockcen72/codekey?style=flat&logo=github&logoColor=white" alt="GitHub Stars" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License" /></a>

<p align="center">
  <a href="#%E5%8A%9F%E8%83%BD">功能</a> •
  <a href="#%E5%BF%AB%E9%80%9F%E4%B8%8A%E6%89%8B">快速上手</a> •
  <a href="#%E9%9A%90%E7%A7%81%E4%BF%9D%E6%8A%A4">隐私保护</a> •
  <a href="#%E6%89%8B%E6%9C%BA%E5%BA%94%E7%94%A8">手机应用</a> •
  <a href="#%E5%91%BD%E4%BB%A4">命令</a>
</p>

<br />

<img src="https://codekey.tinymoney.cn/assets/readme/sidebar-v1.png" height="320" alt="CodeKey 侧边栏" />
<img src="https://codekey.tinymoney.cn/assets/readme/mobile-history-v1.jpg" height="320" alt="手机会话列表" />
<img src="https://codekey.tinymoney.cn/assets/readme/mobile-session-v1.jpg" height="320" alt="手机会话详情" />

</div>

<br />

AI 编程助手总在最关键的时候停下来——等你去批准写文件、运行命令、回答问题。**CodeKey 把这些等待点从电脑搬到了你的手机上。**

- 手机上即时收到审批卡片
- 随时随地发送后续指令
- 在 VS Code 侧边栏统一管理 Claude Code、Codex 和 OpenCode 会话
- 端到端加密保护你的提示词、指令和任务摘要
- 支持微信小程序和 Telegram Mini App

---

## 功能

| | 功能 | 说明 |
| --- | --- | --- |
| 📱 | **手机审批** | Claude Code、Codex、OpenCode 的权限请求会实时推送到手机，支持批准、拒绝和回复。 |
| ⌨️ | **远程指令** | 在手机上输入提示词，本地 VS Code 编程助手继续执行任务。 |
| 📋 | **会话同步** | 按运行状态、时间查看本地编程助手会话。 |
| 🎛️ | **VS Code 控制台** | 在侧边栏配对设备、管理同步、查看会话和审批卡片。 |
| 🔒 | **端到端加密** | 用户提示词、手机指令、任务摘要经过加密后才经过中继服务器。 |
| 📲 | **多平台** | 支持微信小程序和 Telegram Mini App。 |

## 快速上手

```bash
# 1. 安装 CodeKey VS Code 扩展
# 2. 从活动栏打开 CodeKey 视图
# 3. 点击"配对设备"并扫描二维码
# 4. 启动 Claude Code、Codex 或 OpenCode
# 5. 在手机上审批、监控和发送指令
```

## 隐私保护

CodeKey 结合端到端加密和本地隐私过滤，你可以精确控制手机能看到多少会话历史。

| 模式 | 手机可见内容 | 适用场景 |
| --- | --- | --- |
| **关闭** | 仅审批卡片，不共享会话历史 | 最大程度减少数据暴露 |
| **摘要** | 安全的状态摘要，不含原始提示词或助手输出 | 跟踪进度，减少内容暴露 |
| **完整** | 经过本地密钥扫描和黑名单检查后的完整会话历史 | 丰富的远程监控和后续指令 |

隐私控制包括：

- **端到端加密** — 用户提示词、手机指令、任务摘要在离开设备前用 AES-GCM 加密
- **密钥扫描** — API 密钥、令牌、密码等敏感信息在本地脱敏
- **黑名单 / `.codekeyignore`** — 阻止指定文件和路径被转发
- **按助手配置** — 分别为 Claude Code、Codex、OpenCode 设置策略
- **审计面板** — 在侧边栏查看已转发、已拦截、已脱敏的事件统计

## 手机应用

| 平台 | 使用方式 |
| --- | --- |
| **微信小程序** | 扫描 CodeKey 侧边栏的二维码即可配对 |
| **Telegram Mini App** | 通过 Telegram 配对，在聊天中管理会话 |

## 命令

| 命令 | 说明 |
| --- | --- |
| `CodeKey: Pair Device` | 配对手机设备 |
| `CodeKey: Show Dashboard` | 打开管理面板 |
| `CodeKey: Enable Hook` | 启用 Claude Code 钩子 |
| `CodeKey: Enable OpenCode Integration` | 启用 OpenCode 集成 |
| `CodeKey: Start Codex Session` | 启动 Codex 会话 |
| `CodeKey: Toggle Debug Log` | 切换详细调试日志 |

## 系统要求

- VS Code 1.96+
- Claude Code CLI、Codex CLI 或 OpenCode
- 微信小程序或 Telegram Mini App

## 参与贡献

发现了 Bug 或有功能建议？欢迎提交 [issue](https://github.com/rockcen72/codekey/issues) 或 PR。

## 许可证

[Apache 2.0](LICENSE)
