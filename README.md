# dsh-channel-feishu

给 DeepSeek Harness（DSH）装一条**专用飞书通道**：DSH 里的 Agent 可以把消息发到飞书，
用的是你自己在飞书开放平台新建的自建应用（独立机器人，不和 MyAgents 现有 4 个通道抢事件）。

## 架构（v0.5.0：框架 + provider）

```
index.js               通道框架：工具、入站投递、turn 回传、会话/工作区/权限/命名/状态/日志
providers/registry.js  provider 注册表：provider: 'feishu' → 工厂
providers/feishu.js    飞书适配器：token、收发消息、附件上传、卡片、事件解析、长连接
```

框架不 import 任何飞书 API；它只调用 provider 的契约：

| 方法 | 作用 |
|---|---|
| `settings()` | `{ appId, appSecret, region, baseUrl, defaultChatId }` |
| `checkStatus(signal)` | 凭据/令牌状态 |
| `sendText({ chatId, text })` | 发纯文本 |
| `sendAttachment({ chatId, path, name })` | 发附件（图片或文件） |
| `parseInbound(event)` | 归一化入站事件；`unsupported` 表示类型不支持 |
| `downloadImage({ messageId, imageKey })` | 入站图片落盘，返回本地路径 |
| `card.create/attach/update/close` | 流式卡片的四个原子操作 |
| `connect({ onEvent, onState })` | 建长连接，返回清理函数 |

接新 IM = 写一个 `providers/<id>.js` 实现上表 + 在 `registry.js` 注册 + 配置 `provider: '<id>'`，
`index.js` 一行不用改。

## 当前能力（v0.4.0）

| 能力 | 作用 |
|---|---|
| 入站 | 飞书私信经 websocket 长连接投递进一个 DSH 会话，**正文就是用户原话**，不带任何路由提示词 |
| 出站（自动） | 每轮结束时把该轮答复自动发回来源飞书会话；默认用 **CardKit 流式卡片**（打字机），失败降级为纯文本 |
| `feishu_send_file` | 发**附件**：图片走 image 消息，其余走 file 消息（先上传拿 key，再发引用） |
| `feishu_send_message` | 主动发到**别的**会话时才需要；来源会话的回复已自动回传，不要重复调用 |
| `feishu_channel_status` | 报告通道是否配置、region / 默认目标，以及 tenant_access_token 能否取到 |

设计要点：**通道是传输层，不是提示词约定**。飞书会话 id、发送者、回复目标都存在插件的
sidecar（`feishu-channel-state.json` 的 `chats`，以及进程内的 chat memory），不进用户消息——
所以会话记录里不会出现 `[飞书私信] chat_id=…` 这类前缀，也不会逼模型每轮调工具。

出站链路（`apply` → `startInbound` 内注册监听）：

- `agent/assistant-stream` 的 `text-delta` → 节流写进本轮的卡片（**~120ms 一批，同一张卡串行写，sequence 严格递增**，接近打字机）
- `session/event` 的 `assistant/message` → 提交该步正文
- `session/event` 的 `turn/end` → 收尾：补最后一段、关闭 `streaming_mode`、写摘要
- 本轮若已调用 `feishu_send_message`（卡片关闭或失败时）则跳过自动回传，避免双发

**入站**接受纯文本、富文本（图文 post）和单张图片：post 抽文字、图片下载到本地并把路径写进消息；
文件/语音/卡片仍会丢弃并在日志里记原因。目标会话**不需要在 app 里打开**——没有活 agent 时插件
自己 `resume` 上次对话，会话还不存在时可以按 `sessionMode: create` 新建。

实现上没有依赖任何 npm 包：直接用平台 `fetch` 调飞书 Open API，并用 `ctx.tools.register()`
接受的原始 JSON Schema 形式声明工具（入站长连接额外用飞书官方 `@larksuiteoapi/node-sdk`，
缺它只是入站关闭，工具照常可用）。

## 安装

从仓库直接装（DSH 读取仓库根的 `cordis.patch.yml`）：

```bash
dsh plugin add dsh-channel-feishu
```

或用 Release 里的压缩包（`v0.7.0` 起附带）：

```bash
dsh plugin add https://github.com/Poy-Coder/dsh-channel-feishu/releases/download/v0.7.0/dsh-channel-feishu-0.7.0.tgz
```

依赖必须用扁平结构装（非 ASCII 目录下 pnpm 的软链会把路径写坏）：

```bash
pnpm install --node-linker=hoisted
```

## 权限（飞书后台）

- `im:message`、`im:message:send_as_bot`：发消息
- `im:message.p2p_msg:readonly`（私聊）或 `im:message.group_at_msg:readonly`（群 @）：收消息
- `cardkit:card:write`：流式卡片；缺这条 `streamingCards` 会自动降级为纯文本
- 事件订阅方式选 **使用长连接接收事件**，订阅 `im.message.receive_v1`，改完要**发布版本**才生效

安装前的 profile 清单与 patch 备份在 `D:\dsh\工作区\_tools\desktop-profile-*.bak`。

## 一次性准备：创建飞书自建应用（约 5 分钟）

1. 打开 <https://open.feishu.cn/app>，开发者后台 → **创建企业自建应用**（名称例如 `DSH`）。
2. **凭证与基础信息** → 记下 `App ID` 与 `App Secret`。
3. **添加应用能力** → 勾选 **机器人**。
4. **权限管理** → 开通（至少）：
   - `im:message`（读取与发送单聊、群组消息）
   - `im:message:send_as_bot`（以应用身份发消息）
   - 之后做入站还需要 `im:message:receive_v1` 相关事件权限
5. **版本管理与发布** → 创建版本 → 申请发布（企业内需管理员审批）；审批通过后机器人才能对外发消息。
6. 把机器人加进目标群，或先在飞书里私聊机器人。

### 拿到目标 ID（open_id / user_id / chat_id）

飞书**客户端看不到 open_id / user_id**（个人资料页不展示），只能在开放平台侧取：

| 想要 | 接口 | 需要的权限 | 本应用现状 |
|---|---|---|---|
| 应用可见范围内所有用户 open_id | `GET /open-apis/contact/v3/scopes` | 无需额外权限 | ✅ 可用，返回 `ou_9e94dc6112b3db9697df1e7c51cb91ce`（= 应用创建者/你本人） |
| 邮箱或手机号 → open_id | `POST /open-apis/contact/v3/users/batch_get_id?user_id_type=open_id`，body `{"emails":["..."]}` | `contact:user.id:readonly` | ⚠️ 未开通（报 99991672，按返回里的链接申请即可） |
| 机器人所在群列表 → `oc_...` | `GET /open-apis/im/v1/chats` | `im:chat:read` | ✅ 可用（当前为空：机器人还没进群） |
| 发送者是谁（事件回调） | 订阅 `im.message.receive_v1`，读事件里的 `sender.sender_id.open_id` | `im:message.p2p_msg:readonly` | ✅ 已具备权限；回调已是 **websocket 长连接**模式 |
| user_id（企业内标识） | `contact:user.employee_id:readonly`（user token）或管理后台导出 | 按接口 | 未开通；机器人发送用 open_id 就够 |

本机实测结论（应用 `知微` / `cli_aa8f9f976e389ccc`）：

- `contact/v3/scopes` → `ou_9e94dc6112b3db9697df1e7c51cb91ce`
- 用它发消息成功，返回该单聊的 `chat_id` = `oc_b83326e43b4f4981cfe75b654efd5edc`
  → 已写入 row config 的 `defaultChatId`，`feishu_send_message` 不带参数即可发到你的飞书单聊。

也可以不配默认值，每次调用显式传 `receiveId`：`oc_...` 自动按 `chat_id`，`ou_...` 按 `open_id`，
其它情况用 `receiveIdType` 指明（`email` / `user_id` / `union_id`）。

## 配置

凭据按 **row config → 环境变量 → 凭据文件** 的优先级合并，任何一处给全即可。

### 方式 A（推荐）：凭据文件，不写进 profile patch

编辑/新建 `~/.dsh/feishu-channel.json`：

```json
{
  "appId": "cli_xxxxxxxxxxxx",
  "appSecret": "xxxxxxxxxxxxxxxx",
  "region": "feishu",
  "defaultChatId": "oc_xxxxxxxxxxxx"
}
```

插件最多每 5 秒重读一次该文件，改完直接重试工具即可（前提是新代码已加载，见下）。
secret 留在 profile patch 之外；文件权限依赖用户目录本身。

### 方式 B：环境变量

给 Harness 进程设 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（Windows 上从终端启动 Harness 时才方便）。

### 方式 C：profile patch（会覆盖整段 config）

**不要把 appSecret 写在这里。** patch 是整段替换，混入凭据后一旦被备份/贴图就泄漏；
凭据只放方式 A 的文件里，patch 只写行为字段：

```yaml
- id: feishu-channel
  name: 'dsh-channel-feishu'
  config:
    enabled: true
    inboundEnabled: true
    sessionId: 'session-xxxxxxxx-…'
    sessionMode: create
    allowedUsers: ['ou_…']
    streamingCards: true     # 流式卡片；false 或权限缺失时自动降级纯文本
```

注意：profile patch 语法错误会导致 Harness 启动失败；这个文件被 HMR 监视，改完即时生效。

### 入站相关字段（都在同一个 config 里）

```yaml
    enabled: true
    inboundEnabled: true
    sessionId: 'session-3c379bd7-…'   # 入站消息投递到哪个会话
    allowedUsers:                     # 只接受这些 open_id；留空/省略 = 不限制
      - 'ou_…'
    sessionMode: resume               # resume（默认）| create | off
    streamingCards: true              # 出站用 CardKit 流式卡片（默认 true）
    preset: cordis                    # 可选：固定 agent preset；省略则用会话里存的那个
    cwd: 'D:\dsh\工作区'              # 仅在 create/新建会话时使用；省略则用插件所在工作区
    idleReleaseMinutes: 30            # 空闲多少分钟后交还 agent；0 = 保活到插件卸载
    logFile: 'C:\Users\…\feishu-inbound.log'  # 省略则写 <DSH_HOME>/feishu-inbound.log
    stateFile: 'C:\Users\…\feishu-channel-state.json'  # /new 切换的会话 + 会话→飞书 chat 映射
    notifyOnNew: true                 # /new 不带内容时，是否在飞书回一句确认
    workspacePath: 'D:\dsh\feishu'     # 飞书会话的专用工作区目录（省略则用该默认值）
    inboundFilesDir: 'C:\Users\…\feishu-inbound-files'  # 入站图片落盘目录（省略则同目录）
```

### 权限（无人值守）

飞书轮次没有人在界面前点授权，`approval: ask` 会卡在第一次授权上，所以通道给**飞书工作区**
的会话套用固定预设：

```yaml
    permissionPreset: 'danger-full-access'   # 默认值；applyPermissionPreset: false 可关闭
```

生效范围是 `cwd` 等于 `workspacePath`（默认 `D:\dsh\feishu`）的**所有**会话，包括：

- 入站消息激活/新建的会话（`resume` / `create` / `/new` 三条路径都会调）；
- 你在 GUI 里于「飞书」工作区手动新建的会话（`turn/start` 时套用）。

`permissionPresets.current()` 先比对，已经在该预设上就不再写事件，所以每轮重复调用是幂等的。
想恢复逐次确认：把 `permissionPreset` 设成 `workspace-write` 或 `applyPermissionPreset: false`。

### 会话命名（列表里不出现无名条目）

工作区列表那一行读的是**挂载那一刻**的 projection cache；标题由模型异步生成，所以顺序必须是
「投递首条消息 → 生成标题 → 挂到工作区」，反过来就会留下没名字的行（客户端不会因标题后到而刷新该行）。

插件现在的顺序：

1. `sessionTitle.refresh()` 让模型生成标题（6 秒超时）；
2. 模型失败、超时，或返回 `Greeting` / `New session` / `未命名` 这类占位词时，
   用消息首行 `rename()` **钉住**一个短标题（`session/title` 事件，source=user）；
3. 有了标题再 `attachSession()` 到 `workspacePath`；失败时也照样挂载，只是标题为空。

已有会话若标题仍是占位词，下一条消息到达时会被换成那一条的原话。

### 斜杠命令（在飞书里直接发，不消耗回合）

| 命令 | 作用 |
|---|---|
| `/help` | 命令清单 |
| `/status` | 当前会话、标题、运行状态、工作区、权限、入站与目标群 |
| `/new [内容]` | 开一段新会话；带内容则作为第一条消息 |
| `/rename <标题>` | 给当前会话改名（钉住标题，模型不会再改） |
| `/stop` | 中断进行中的回合（`agent.cancel({kind:'user'})`） |

命令在 `handleInboundEvent` 里被拦截：**既不会投递给模型，也不会写进会话记录**，只回一条飞书消息并把 `event=slash` 记进诊断日志。未识别的 `/xxx` 同样拦截并回帮助，避免误当任务执行。

### 入站工作方式

1. 飞书私信 → websocket 长连接 → `im.message.receive_v1` → 过滤（`allowedUsers`、消息类型、去重）→ 投递。
   消息类型：`text` 直接取文本；`post`（图文富文本）抽出标题/正文，并把其中的 `img` 下载到
   `inboundFilesDir`；`image`（单图消息）下载那一条。图片最多取 4 张，文件名形如
   `<message_id>-<image_key 尾 10 位>.<webp|png|jpg|gif>`，消息里会附上本地绝对路径，agent 直接 `read_image` 就能看。
   其它类型（`file`/`audio`/`media`/`sticker`/卡片）照旧丢弃，日志记 `dropped reason=non-text message_type=…`。
2. **开新会话**：在飞书发 `/new` 即新建一段对话并切过去（不带内容时用机器人回一句确认）；
   `/new 帮我看下 X` 则把后面那句作为新会话的第一条消息。切换结果写进 `stateFile`，重启后依然有效。
   想切回配置里的会话：删掉 `stateFile`（或把 `sessionId` 指过去后删掉它）。
3. 找 agent 的顺序（因此**不需要**把会话开在 app 里）：
   - 已有活 agent → 直接用（app 的会话控制器也是先复用活 agent，所以你随后在 GUI 打开同一会话，
     看到的是**同一个 agent、同一份对话**，不会互斥）；
   - 否则 `ctx.agents.resume({ resumeSessionId: sessionId })` 激活上次对话
     （DSH 自带的无界面 ACP 客户端走的就是这条）；
   - 再失败且 `sessionMode: create` → `ctx.agents.create()` 新建（`cwd` 用 `cwd` 配置值，
     否则用 `workspacePath`，默认 `D:\dsh\feishu`）。
   注意：默认**续接原会话**；`create` 只是"会话不存在时"的兜底，不会主动新开一段对话。
4. **工作区归属**：插件新建的会话在建完立刻登记到 `workspacePath` 指向的「飞书」工作区
   （`workspaceRegistry.resolveByPath` → 没有就 `create` → `attachSession`），所以 GUI 的工作区
   列表里会实时出现这些会话，不需要重开 app。
   限制：DSH 的 `attachSession()` 会校验会话 header 的 `cwd` 必须等于工作区目录，因此
   **已有会话不能直接搬过来**——想让老会话进飞书工作区，只能让它以该目录为 cwd 重建。
   `workspaceRegistry` 不可用（DSH 大版本变化）时只设 cwd、不登记，投递照常。
4. resume/create 都会用 `ctx.get('agentPresets').resolve/mount` 挂上会话里存的 agent preset
   （和 app 打开会话时的组合完全一致）。不挂的话 agent 只剩全局注册的工具——本机实测 16 个，
   挂上后 39 个（缺的那批是 `pwsh/read/write/edit/grep/glob` 等）。
5. 投递的消息是**完整带身份**的 user 消息（`id` + `role: 'user'` + `source` + `content`）。
   缺 `id` 或 `role` 会让会话日志在下次加载时报 corrupt / 请求被 API 422 拒绝。
6. 空闲 `idleReleaseMinutes` 分钟后（且没有回合在跑）插件交还 agent；app 随后按需重新 resume，
   所以释放是安全的，静默通道不占内存。
7. 每次入站的结论都写一行 JSONL 到 `logFile`：`delivered` / `dropped`（含原因）/ `error` /
   `release` / `switched`。飞书"发消息没反应"时先看这个文件。

### 什么时候要重启

装入新 bundle 时 HMR 会直接生效；但**替换已加载插件的 JS 代码需要重启一次 Harness**
才能加载新的模块代（profile 的 patch/manifest 变更不算）。本机就是这样：
插件装好后先加载的是 v0.1 代码，加入凭据文件支持后需要重启一次才认这个文件。

## 验证

在任意 DSH 会话里：

1. 调 `feishu_channel_status` → 应返回 `configured=true, tokenOk=true`；
2. 调 `feishu_send_message`，参数 `{"text":"DSH 通道测试"}`（配了 defaultChatId）→ 飞书应收到消息，返回 messageId。

## 已知边界

- 入站支持**纯文本、富文本（图文 post）与单张图片**：post 抽文字 + 最多下载 4 张图，图片落到
  `inboundFilesDir` 并在消息里给出本地路径。`file`/`audio`/`media`/`sticker`/交互卡片仍未支持。
- token 按 appId 进程内缓存，提前 60s 过期；不做持久化。
- 错误以工具错误结果返回（不会中断整轮对话），包含飞书 `code/msg`。
- 入站要求飞书应用开通 `im.message.receive_v1` 事件（长连接模式）并已发布版本。
- 入站自动 `resume`/`create` 出来的 agent 会用会话里存的 preset 组合（见上）；但不会安装 API
  控制器额外的模型选择控件，模型路由走 agent-loop 默认 + 会话 `request/header` 的历史选择。
- 插件持有的 agent 空闲释放时若你正在 GUI 里看那个会话，视图会掉一次（下次交互会重新 resolve）。
- 缺 `id`/`role` 的消息会写坏会话日志，且 DSH 目前只在加载时校验——所以投递形状由
  `test/smoke.mjs` 钉死，改动时别绕过。

## 开发

```powershell
node test/smoke.mjs   # 用假 ctx 校验注册、schema 子集与错误路径，不发网络请求
```
