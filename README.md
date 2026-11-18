# dsh-channel-feishu

给 DeepSeek Harness（DSH）装一条**专用飞书通道**：DSH 里的 Agent 可以直接在飞书里聊，
每轮答复自动回传成流式卡片，收到的图片和文件落进工作区，需要你拍板时发交互式问答卡。

而且它**不会静默**：一轮跑几分钟也不让你干等——卡片上持续显示当前在跑哪个工具、已调用
几个工具、已用时多少秒，思考过程另有单独一条消息，Agent 在干什么随时看得见。

用的是你自己在飞书开放平台新建的自建应用（独立机器人），不和别的通道共用事件。

**配套（建议一并安装）**：

- [`dsh-im-indicator`](https://github.com/Poy-Coder/dsh-im-indicator) —— **推荐装**：在 DSH 左侧会话列表直接看出「哪条会话正被飞书驱动、它现在在回答还是已完成」，一行胶囊 + 一个状态点，零依赖约 7 kB；
- [`dsh-channel-wechat-ilink`](https://github.com/Poy-Coder/dsh-channel-wechat-ilink) —— 同一套框架的微信通道，可与飞书同时在线。

## 为什么这么设计

常见的 IM 桥接是「群机器人 + webhook」：消息先转发到某个中间服务，再把回复贴回群里。这条通道反着做，几个取舍是有意的：

- **一个应用只服务一个人**：自建应用 + 独立机器人，事件走长连接直达你本机，不经第三方中继，飞书侧也只是一条普通私聊；
- **会话是主体，聊天窗口只是入口**：一条通道绑定一个 DSH 会话，上下文、工具调用、产物都留在本地会话里，换设备、重开 app 都不丢；
- **要你拍板时发卡片，不靠解析自然语言**：结构化问答卡点选即回传，避免「回复 1 表示同意」这类靠猜的交互；
- **附件落在工作区**：图片和文件直接进 `<workspacePath>/attachments/`，Agent 用本地路径读取，不用去临时目录里翻；
- **无人值守优先**：会话激活即切权限预设，长任务不会卡在授权确认上；问答卡的回调也在通道内闭环，不需要开网页。

代价是它只适合「一个人、一台机器、一个长期会话」的用法——这正是下面这条边界的由来。

## 当前版本不支持群聊

0.9.x 只支持**单聊**（你和机器人一对一）。把机器人拉进群不会工作：群消息的会话绑定关系不成立，插件按单聊逻辑处理会直接丢弃。

群聊要解决的是另一个问题——群里谁在跟 Agent 说话、上下文怎么隔离、多人同时提问怎么排队。这些等实际反馈，不在当前版本里做。

## 它提供什么

- **双向通道**：飞书私聊 → DSH 会话；一轮结束把答复自动发回原聊天，不需要模型调工具
- **流式卡片**：思考过程单独一条消息，正文卡片逐字出现，底栏依次是 `等待回答 → 流式输出中 → 完成`
- **不会静默**：工具开始/结束时卡片立刻更新，长任务期间每 10 秒刷新一次进度——`正在执行 feishu_send_file · 已调用 3 个工具 · 已用时 42s`，不用猜它是卡住了还是在干活
- **出错会说话**：回合失败、消息没投递到会话、长连接断开超过 20 秒、进程半途退出，都会往飞书推一条写明原因的通知，而不是安静地少一条回复（`problemNotices: false` 可关）
- **问答卡**：`ask_user_question` 渲染成卡片，选项文字整行显示、下面一排数字按钮作答；多题**逐题发**，答完才发下一题；选项都不合适就点「补充」再直接回复文字，答完的答复落在问答卡下方
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
dsh plugin add https://github.com/Poy-Coder/dsh-channel-feishu/releases/download/v0.9.24/dsh-channel-feishu-0.9.24.tgz
```

依赖必须用扁平结构装（非 ASCII 目录下 pnpm 的软链会把路径写坏）：`pnpm install --node-linker=hoisted`。

> **更新插件后必须重启本机的 DSH**：通道代码在 DSH 启动时加载，没有热更新；
> 只 `dsh plugin add <新版本>` 而不重启，跑的还是旧代码（`feishu_channel_status` 里的版本号也还是旧的）。

安装包的 bundle patch 会插入通道行，**入站默认关闭**（`inboundEnabled: false`），装完重启一次即可；
第一条飞书消息会自动建会话和「飞书」工作区，不需要先手填 `sessionId`。

### 开启入站前先看这三个默认值

| 配置 | 默认 | 含义 |
|---|---|---|
| `inboundEnabled` | `false` | 打开后，应用可见范围内的任何人都能驱动本地 Agent；确认允许名单后再开启 |
| `allowedUsers` | `[]` | 空不是"谁都可以"：第一个发消息的人会**绑定**该通道，之后其他人被拒。想指定就显式列出 open_id |
| `permissionPreset` / `applyPermissionPreset` | `danger-full-access` / `true` | 无人值守时没人能点审批，所以通道工作区里的会话会切到这个预设；觉得太大就改成 `workspace-write` 或关掉 apply |


凭据写到 `~/.dsh/feishu-channel.json`（或设 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`），
也可以跑 `node scripts/setup.mjs`：它会从环境变量、现有凭据文件、各 profile 配置里找出
appId/appSecret，先用飞书接口校验 token，再以 UTF-8 无 BOM 写入。

允许名单：`allowedUsers` 留空时第一个发消息的人绑定该通道，其他发送者会被拒绝；
想指定多人就显式列出 open_id。

## 版本兼容

manifest 里声明了 `engines.dsh`（当前 `>=0.2.2-rc.3 <0.3.0`），DSH 在加载前会按这个范围检查：

- **不在范围内**：插件管理器拒绝激活，并给出「要求 … ／当前 …」的说明（设置 → 插件里能看到），不会静默失效；
- **想强跑**：可以给这一版 DSH 一个精确版本豁免（插件管理器或 `dsh plugin allow-version`），风险自负；
- **已给豁免**：插件加载后自检，发现运行版本不在声明范围，会往飞书推一条「插件和这版 DSH 不匹配」；就绪通知里也同时带插件版本和 DSH 版本，方便对账。

升级 DSH 后如果插件跟不上：`dsh plugin add dsh-channel-feishu@latest`（本地开发副本则改 `engines.dsh` 并重装），然后重启 DSH。

### 更新插件后必须重启本机 DSH

通道代码在 DSH **启动时**加载，没有热更新。只执行 `dsh plugin add <新版本>` 而不重启，跑的还是旧代码——插件管理器里显示的是新版本，实际行为仍是旧的（`feishu_channel_status` 返回的 `pluginVersion` 也是旧的）。

所以每次更新插件后：**退出并重新打开 DSH**（或跑一次你本机惯用的重启脚本），再用 `feishu_channel_status` 确认 `pluginVersion` 已是新版本。这也是排查“更新了但问题没变化”的第一步。

### 兜底：插件没加载时由外部提醒

插件被拦下时自己跑不起来，所以工作区里带了一个不依赖插件的看门狗 `check-plugin-health.ps1`：

- 插件加载后每 5 分钟刷新 `~/.dsh/feishu-channel-runtime.json` 的心跳；
- 脚本判断「DSH 在跑、profile 装了插件、行没 `disabled: true`，但心跳超过 15 分钟没更新」→ 用机器人自己的 API 直接发飞书提醒（只读 `~/.dsh/feishu-channel.json`，不经过插件），写明最后一次成功加载的插件版本、DSH 版本、声明范围和处理建议；
- 默认 6 小时内只提醒一次；`-DryRun` 先看文案。

```powershell
schtasks /Create /SC MINUTE /MO 30 /TN "DSHFeishuPluginHealth" `
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"<workspace>\check-plugin-health.ps1\"" /F
```

不想用 Windows 计划任务，也可以在 DSH 里建一条定时任务定期执行这个脚本。

## 纯文本通道（微信）

微信 ClawBot 没有卡片，也不能编辑消息；实测客户端只在收到 FINISH 时渲染一次，重复 `client_id` 的 GENERATING 帧会被当成重复消息——所以这条通道**不做流式**，走另一套策略（`providers/wechat.js` + `providers/text-stream.js`）。

**能用的部分**：文本/图片/文件双向收发、提问卡以纯文本编号发出、输入状态、进度消息、一轮一条完整回答（超长才拆续条）、独立工作区（`<非系统盘>/dsh/wechat`），飞书与微信可同时在线（两个 bundle）。

**已知限制**（都是协议层，不是实现偷懒）：

- 没有卡片、不能编辑消息，所以回答**一轮一条完整消息**，不做流式；
- **没有历史消息接口**。iLink 只提供 `getupdates` 长轮询，飞书那种“断线后按时间补拉漏掉的消息”在微信侧**做不到**；
- 因此微信通道用两个定时器兜底（`providers/wechat.js`）：长轮询超过 2 分钟没有完成就中止并重建（日志 `rebuild`）；游标 20 分钟没有新消息就重置一次 `get_updates_buf` 重新拉取（日志 `cursor-reset`，只接受最近 30 分钟的消息，已答的按 `message_id` 去重）。`wechat_channel_status` 的 `poll` 字段能看到 `lastOkAt` / `rebuilds` / `cursorResets` / `stalled`。

**登录**：

```bash
node scripts/wechat-login.mjs --qr   # 二维码直接画在终端，并落一张 PNG 到 ~/.dsh/wechat-qr.png
```

流程是：发一条消息 → 手机扫码 → 凭据写入 `~/.dsh/wechat-channel.json`（0600，不入库、不进日志）。`--qr` 依赖 devDependency `qrcode`；没装时会退回打印 `QR_URL`，你可以自己渲染，不需要把登录 token 交给第三方二维码服务。

**端到端自测**：`node scripts/wechat-e2e.mjs` —— 等你从微信发一条消息，然后按两段回复并打印耗时，用来验证“收得到 + 发得出”。

**问答**：`ask_user_question` 以纯文本发出，编号选项 + 一句话说明怎么答：

```
需要你的回答：

确认改哪里
这个新会话里我没有上一轮的上下文——「介绍」指哪一份？

1. 插件详情页 docs/DETAIL.zh.md（推荐）
2. README 开头 +「它提供什么」
3. 两处都加

回数字选一个；选项都不合适，就直接打字补充；回「跳过」不作答。
```

回 `2` 就是第二项；回「两个都不合适，我补充一句」会被当成补充答案交给模型；回「跳过」跳过。**不用加前缀、不用记命令**——插件按「能对上选项就用，对不上就当补充」处理。

**进度**：收到消息立刻显示「对方正在输入…」，**每 5 秒续期一次**（协议里的输入状态会过期，官方客户端同样 5 秒续一次）；超过 `textProgressSeconds` 秒还没有正文，才补一条 `还在跑 · 正在执行 pwsh · 已调用 2 个工具 · 已用时 35s`。

| 参数 | 默认 | 说明 |
|---|---|---|
| `typingRenewSeconds` | `5` | 输入状态多久续期一次；`0` = 每轮只发一次（长任务中途可能看不到输入状态） |
| `textProgressSeconds` | `30` | 多少秒没正文就发一条进度；`0` = 关闭进度气泡（只剩「正在输入」）；嫌 30 秒太频繁就调大，比如 60 / 120 |

想做到「全程只有正在输入、没有任何进度气泡」，把 `textProgressSeconds` 设成 `0` 即可；`typingRenewSeconds` 保持 5 秒，长任务期间输入状态不会消失。

同一条进度不重复：只有工具或调用次数变了才发新的，间隔至少 3 分钟、每轮最多 3 条；正文一开始就不再发进度。飞书通道忽略这个参数（它用卡片每 10 秒刷新）。

**正文**：**一轮一条完整消息**，不拆段、不做流式帧（客户端限制，实测无法原地刷新）。只有超过 1800 字的回答才按上限拆续条；发送失败会隔 800ms 重试一次。

**投递可靠性**：`context_token` 由入站消息签发且会过期，过期后发送返回 `ret=-2 prepare failed`；插件不会删除已存的 token（删了会让后续回复彻底发不出去），失败时只做一次无 token 重试并记录 `finish-failed`。

**补拉（漏消息兜底）**：iLink 的 `get_updates_buf` 游标是单调的，轮询一旦卡住或服务端提前返回空响应，连接看起来正常但消息就是不进来。插件为此做了三层：

| 机制 | 作用 |
|---|---|
| 轮询看门狗 | `getupdates` 超过 120 秒没完成 → 重建长轮询 |
| 空闲游标重置 | 20 分钟没消息 → 用空游标重新开始（空游标只收新消息） |
| **冷读补拉** | 每 2 分钟 reconcile 时，用**记录下来的旧游标**再拉一次过去 10 分钟的消息，按 `message_id` 去重后补投 |

冷读之所以可行，是因为实测确认：**旧游标会重放它已经越过的消息**（空游标不会）。游标历史每分钟采样一次、保留 2 天，写在 `wechat-sync.json` 的 `history` 里；冷读不会写回当前游标，所以不会让轮询跳读。想手动验证可以用 `node scripts/wechat-history-probe.mjs --cursor=<旧游标>`。

### 两个通道各用各的工作区

每个通道按 `provider` 生成自己的一套名字，互不覆盖：

| 项目 | 飞书 | 微信 |
|---|---|---|
| 默认工作区目录 | `<非系统盘>/dsh/feishu` | `<非系统盘>/dsh/wechat` |
| 工作区标题（GUI 分组） | 飞书 | 微信 |
| 新会话标题前缀 | `飞书会话 …` | `微信会话 …` |
| 状态文件 | `<DSH_HOME>/feishu-channel-state.json` | `<DSH_HOME>/wechat-channel-state.json` |
| 诊断日志 | `feishu-inbound.log` | `wechat-inbound.log` |
| 运行时标记（崩溃检测） | `feishu-channel-runtime.json` | `wechat-channel-runtime.json` |
| 工具名 | `feishu_send_message` / `feishu_send_file` / `feishu_channel_status` | `wechat_send_message` / `wechat_send_file` / `wechat_channel_status` |

`workspacePath` 写了就用写的；只有两行都写同一个路径时，两个通道才会共用工作区。

**为什么是两个 bundle 而不是同一个包的两行**：Cordis 按模块 URL 缓存，同一个包的两行会共用模块里的 `activeProvider` 等状态，后加载的那行会把前一行顶掉。所以微信会作为独立 bundle（`dsh-channel-wechat`，由同一份源码生成）发布，各自持有模块状态；两个包各插自己的一行，才能真正同时在线。

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
    inboundEnabled: false       # 默认关；开启后可见范围内的人都能驱动 Agent，先配 allowedUsers
    sessionMode: create         # 没有会话时，第一条消息自动建
    workspacePath: ""           # 空 = 按通道默认：飞书 dsh/feishu、微信 dsh/wechat
    allowedUsers: []            # 空 = 第一个发消息的人绑定此通道；微信则是扫码登录的人
    streamingCards: true
    autoReply: true
    problemNotices: true        # 出错/崩溃时往飞书推原因；关掉只剩日志
    textProgressSeconds: 30     # 纯文本通道（微信）的进度间隔；0 = 不发进度
    mirrorUserMessages: true    # 桌面端消息转发到飞书
    permissionPreset: danger-full-access   # 无人值守没人能点审批；嫌大改 workspace-write
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
- 常见 `result`：`entry`（事件刚到达，带 `messageId`/`type`/`chatId`）、`handled`（回调耗时 `ms`）、
  `delivered`、`bootstrap`（自动建会话）、`owner-bound`、`dropped`（附 `reason`）、
  `parse-null` / `dedupe-hit`（被自身拦下，附原因）、`reconcile`（重连补拉：`clean` / `recovered count=N`）、
  `card-sent`、`answered`、`card-update-failed`。

### 丢消息怎么看

飞书长连接是 best-effort，事件可能落到一条正在退场的连接上而静默消失。因此：

1. 每个事件到达时先写 `entry`——没有 `entry` 就是**事件没到**，不是被插件吞了；
2. 重连成功后 5 秒会拉一次 `im/v1/messages` 对账（窗口 = 最近入站或 10 分钟），把没见过的用户消息补投，
   日志记 `reconcile recovered count=N`；
3. 同一时刻只允许一个 `WSClient`（`client-create/client-close` 带 `ws-N` 编号），避免双连接分食事件。

## 路线图

- **多 IM**：通道层已经按 provider 抽开（`providers/registry.js`），接微信/企业微信只需实现同一份 provider 契约，会话与问答卡逻辑不用重写；
- **扫码配置**：目标是「扫一下就把 `appId` / `appSecret` / `defaultChatId` 写进凭据文件」，替掉现在跑 `scripts/setup.mjs` 这一步；
- **群聊**：视反馈决定，不在 0.9.x 范围内。

## 常见问题

| 现象 | 处理 |
|---|---|
| 装完能收到「通道已就绪」，发消息没反应 | 看日志有没有 `inbound`；老版本在无会话时会直接丢弃 |
| `card-update-failed` / `300309 streaming mode is closed` | 卡片不是流式模式，更新写不进去；0.9.0 起问答卡已开启流式 |
| 一条回答出现两张卡片（一张停在「回复中」并写着「本轮回答见下方 ↓」，一张是正文） | 流式写入与收尾抢同一个 `sequence`（飞书 `300317`），收尾失败后会补发一张。现在同一张卡的写入按 `sequence` 串行，冲突自动重试一次，日志里应只剩 `card closed` |
| 长连接显示「已恢复」，但发消息没反应（出站正常） | SDK 重连可能拿回一条“心跳通、事件不通”的 socket。现在重连后 3 分钟没有入站就重建客户端（日志 `rebuild`），在线期间每 2 分钟补拉一次历史（`reconcile`），漏掉的消息会在 2 分钟内补回 |
| 插件加载失败、工具全消失 | 检查 `package.json` 是否被写成带 BOM 的 UTF-8 |
| 发文件报权限错误 | 应用要开 `im:resource` 上传权限 |
| 同一 App 两条长连接 | 只能有一个通道插件用这个 App，旧通道要先 `disabled: true` |
