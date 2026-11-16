# dsh-channel-feishu

给 DeepSeek Harness（DSH）装一条**专用飞书通道**：DSH 里的 Agent 可以直接在飞书里聊，
每轮答复自动回传成流式卡片，收到的图片和文件落进工作区，需要你拍板时发交互式问答卡。

用的是你自己在飞书开放平台新建的自建应用（独立机器人），不和别的通道共用事件。

## 它提供什么

- **双向通道**：飞书私聊 → DSH 会话；一轮结束把答复自动发回原聊天，不需要模型调工具
- **流式卡片**：思考过程单独一条消息，正文卡片逐字出现，底栏依次是 `等待回答 → 流式输出中 → 完成`
- **问答卡**：`ask_user_question` 渲染成按钮卡，选项一行一个、超过 3 项自动折叠；多题**逐题发**，答完才发下一题；答完的答复直接落在问答卡下方
- **附件**：入站图片和 `file` 消息（pdf/docx/xlsx/zip/音频）都下载到 `<workspacePath>/attachments/`，消息里附上绝对路径
- **会话自动创建**：全新安装时，第一条飞书消息会自动建会话和「飞书」工作区，不需要先手填 `sessionId`
- **桌面端镜像**：在桌面 GUI 里给同一会话发的消息，会以「来自桌面端：…」转发到飞书
- **诊断日志**：`~/.dsh/feishu-inbound.log`，JSONL、带 `level` 分级、4 MB 轮转

## 安装

```bash
dsh plugin add dsh-channel-feishu
```

或从 GitHub 仓库/Release（内容一致）：

```bash
dsh plugin add https://github.com/Poy-Coder/dsh-channel-feishu
dsh plugin add https://github.com/Poy-Coder/dsh-channel-feishu/releases/download/v0.9.6/dsh-channel-feishu-0.9.6.tgz
```

依赖必须用扁平结构装（非 ASCII 目录下 pnpm 的软链会把路径写坏）：`pnpm install --node-linker=hoisted`。

安装包的 bundle patch 会插入通道行并默认开启入站，装完重启一次即可；
第一条飞书消息会自动建会话和「飞书」工作区，不需要先手填 `sessionId`。

凭据写到 `~/.dsh/feishu-channel.json`（或设 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`），
也可以跑 `node scripts/setup.mjs`：它会从环境变量、现有凭据文件、各 profile 配置里找出
appId/appSecret，先用飞书接口校验 token，再以 UTF-8 无 BOM 写入。

允许名单：`allowedUsers` 留空时第一个发消息的人绑定该通道，其他发送者会被拒绝；
想指定多人就显式列出 open_id。

## 配置

### 1. 凭据

按优先级取第一个非空值：行 `config` → 环境变量 → 凭据文件。

```json
{
  "appId": "cli_xxxxxxxxxxxxxxxx",
  "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "region": "feishu",
  "defaultChatId": "oc_xxxxxxxxxxxxxxxx"
}
```

写到 `~/.dsh/feishu-channel.json`；也可以用环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`。
`region` 中国大陆用 `feishu`，国际版用 `lark`。

仓库自带一条命令完成"找凭据 + 校验 + 写文件"：

```bash
node <profile>/node_modules/dsh-channel-feishu/scripts/setup.mjs
```

它会扫描环境变量、现有凭据文件、各 profile 的 `cordis.patch.yml`，先用飞书接口验证 token，
通过后才写入（UTF-8 无 BOM、`0600`）。**不要用 PowerShell 5.1 的 `Set-Content -Encoding UTF8`
手写这个文件**：它会加 BOM，插件会加载失败。

### 2. profile 行

安装包自带的 bundle patch 会插入这一行，通常不需要手动加：

```yaml
- id: feishu-channel
  name: "dsh-channel-feishu"
  config:
    provider: feishu
    enabled: true
    inboundEnabled: true        # 收消息；关掉只剩发送工具
    sessionMode: create         # 没有会话时，第一条消息自动建
    workspacePath: ""           # 空 = <DSH_HOME>/dsh-feishu
    allowedUsers: []            # 空 = 第一个发消息的人绑定此通道
    streamingCards: true
    autoReply: true
    mirrorUserMessages: true    # 桌面端消息转发到飞书
    permissionPreset: danger-full-access
    applyPermissionPreset: true
    region: feishu
    logLevel: info              # debug | info | warn | error
```

`permissionPreset` 默认 `danger-full-access`：飞书是无值守通道，卡在授权确认上就永远没人点。

### 3. 飞书侧

1. 开放平台建**企业自建应用**，开「机器人」能力，加权限 `im:message`、`im:message:send_as_bot`、
   `im:resource`（发文件用）、`im:message.react`（表情回执）；
2. 事件订阅选**长连接**，加 `im.message.receive_v1`；
3. 发布版本并等审核通过。

## 允许名单

`allowedUsers` 为空时**不是对所有人开放**：第一个给机器人发消息的人会被记为该通道的 owner，
之后其他人发消息会被拒绝并收到一条说明。想换人或放开多人，显式写出 open_id：

```yaml
allowedUsers:
  - "ou_xxxxxxxxxxxxxxxx"
```

owner 记在通道状态文件里，删掉状态文件里的 `owner` 字段即可重新绑定。

## 会话

- 全新安装：`sessionMode: create`，第一条消息自动建会话并挂到「飞书」工作区；
- `/new`：开一段新会话（可带内容 `/new 帮我看下 X`），切换结果写入状态文件，重启后仍有效；
- 每次切换都会给会话起一个可见标题，避免在 app 的会话列表里出现无名条目；
- 想切回配置里的会话：删掉状态文件里的 `sessionId` 字段。

## 命令

| 命令 | 作用 |
|---|---|
| `/help` | 命令列表 |
| `/status` | 当前会话、工作区、权限、入站状态 |
| `/new [内容]` | 开新会话（带内容则作为第一条消息） |
| `/rename <标题>` | 改名 |
| `/stop` | 中断进行中的回合 |
| `/model` | 看/切模型 |
| `/think` | 看/切思考强度 |

命令在插件侧拦截，不进模型、不占回合。

## 日志

`~/.dsh/feishu-inbound.log`，每行一条 JSON：

```json
{"time":...,"level":"info","event":"inbound","result":"delivered","sessionId":"..."}
```

- `logLevel` 控制写入门槛，排查时设 `debug`；
- 超过 4 MB 轮转为 `.log.1`，只保留一份；
- 常见 `result`：`delivered`、`bootstrap`（自动建会话）、`owner-bound`、`dropped`（附 `reason`）、
  `card-sent`、`answered`、`card-update-failed`。

## 常见问题

| 现象 | 处理 |
|---|---|
| 装完能收到「通道已就绪」，发消息没反应 | 看日志有没有 `inbound`；老版本在无会话时会直接丢弃 |
| `card-update-failed` / `300309 streaming mode is closed` | 卡片不是流式模式，更新写不进去；0.9.0 起问答卡已开启流式 |
| 插件加载失败、工具全消失 | 检查 `package.json` 是否被写成带 BOM 的 UTF-8 |
| 发文件报权限错误 | 应用要开 `im:resource` 上传权限 |
| 同一 App 两条长连接 | 只能有一个通道插件用这个 App，旧通道要先 `disabled: true` |
