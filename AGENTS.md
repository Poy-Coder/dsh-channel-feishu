# AGENTS.md — read this before installing or configuring the plugin

This file is addressed to **the AI agent** that installs or configures the plugin on
someone's machine. The human does not need to read it, but you MUST follow it: the
plugin cannot be useful until a Feishu app, its credentials, and the inbound switch
are all in place, and only you can walk the user through that.

中文摘要：这份文件是写给**替你装插件的 Agent** 的。装完只是第一步，你必须按这里的
步骤引导用户创建**企业自建应用**、拿到凭证、验证链路，并把结果反馈给用户。
不要只装完就说"好了"。

---

## 0. The contract

1. **Never claim success until the verification checklist (§6) passes.** A bundle that
   merely installed proves nothing: inbound is off by default, and credentials are absent.
2. **Never paste an app secret into chat, a commit, or `cordis.patch.yml`.** Put it in the
   DSH credentials store or `~/.dsh/feishu-channel.json` (§4).
3. **Ask before enabling inbound.** Enabling it lets anyone in the Feishu chat drive the
   local agent, and the plugin applies its `permissionPreset` to that workspace's sessions
   (default `workspace-write`, which still lets the model write anywhere inside the workspace).
4. **Report back to the user** with what you configured, what you verified, and what they
   still must do (§7).
5. **A code change ships with its documentation.** Any behavior a user can observe — a new
   default, a new notice, a new config key, a changed message — updates `README.md` (user
   facing) and this file (agent facing) **in the same release**. A release whose notes
   describe behavior the docs do not mention is incomplete, and a doc-only fix is still a
   release: the published README on npm and the GitHub repo both come from these files.

## 1. Install

```bash
dsh plugin add dsh-channel-feishu            # after it is on npm
# or, from the source repository
dsh plugin add Poy-Coder/dsh-channel-feishu
```

If dependencies fail to resolve on a non-ASCII path, install them flat inside the
package directory: `pnpm install --node-linker=hoisted`.

After installing, the three tools exist immediately (`feishu_send_message`,
`feishu_send_file`, `feishu_channel_status`), but **inbound is disabled**:
`inboundEnabled` defaults to `false` because an unattended bidirectional channel is
an explicit choice.

**Every install or update needs a DSH restart.** The channel code is loaded once at
startup with no hot reload: running `dsh plugin add` and leaving DSH up keeps the old
build running, and the symptom is "I updated it but nothing changed". Restart DSH, then
check `feishu_channel_status` — its `pluginVersion` must name the version you installed.

## 2. Create the Feishu app — the type matters

Tell the user to open <https://open.feishu.cn/app> and use **创建企业自建应用**
("custom app", inside their own tenant).

- **Do not use 商店应用 / ISV / store app.** Store apps are distributed to other tenants;
  events can only reach them through an HTTP callback with a public URL, they cannot use
  the long connection, and most scopes are withheld until review.
- **Do not use 个人版/免费版 personal tenant** when the console offers an enterprise path:
  several scopes (`im:message.p2p_msg`, `contact:user.id:readonly`, `cardkit:card:write`)
  are only grantable in an enterprise (企业) tenant with an admin who can approve releases.
- The app must be **enabled for the bot** («添加应用能力 → 机器人») before Feishu will
  deliver `im.message.receive_v1`.

Required permissions (权限管理):

| Scope | Why |
|---|---|
| `im:message` | send messages |
| `im:message:send_as_bot` | send as the bot |
| `im:message.p2p_msg:readonly` | receive direct messages (or `im:message.group_at_msg:readonly` for groups) |
| `cardkit:card:write` | streaming reply card |
| `im:resource` | upload attachments for `feishu_send_file` |

Event subscription (事件与回调 → 事件配置):

1. Subscription mode: **使用长连接接收事件** (long connection). This is the official
   recommendation for custom apps and needs no public URL; a webhook would require a
   public address, signature verification, and encryption.
2. Add the event **`im.message.receive_v1`** (接收消息 v2.0).
3. Publish a version (版本管理与发布 → 创建版本 → 申请发布). Permission changes and the
   event subscription only take effect **after release is approved**.

Visibility (应用可见范围): the bot must be visible to the user who will chat with it.

## 3. Collect the credentials

In 凭证与基础信息 copy:

- **App ID** (`cli_…`)
- **App Secret**

Write them **without echoing them back to the user**:

```jsonc
// ~/.dsh/feishu-channel.json   (chmod/ACL: user-only)
{ "appId": "cli_…", "appSecret": "…", "region": "feishu" }
```

Or, preferred on this harness, store them in the DSH credentials store as the keys
`FEISHU_APP_ID` and `FEISHU_APP_SECRET`. Resolution order is: row config →
credentials store → environment → the JSON file above.

`region` is `feishu` for open.feishu.cn (China) and `lark` for open.larksuite.com.

## 4. Turn inbound on — with the user's consent

Add to the profile's `cordis.patch.yml` (or the plugin's settings form):

```yaml
- id: feishu-channel
  name: dsh-channel-feishu
  config:
    inboundEnabled: true
    sessionMode: create
    sessionId: session-<a fresh uuid>   # created on the first inbound message
    allowedUsers: ["ou_…"]              # the human's open_id; empty = first sender binds
    workspacePath: ""                   # empty → a non-system-drive default
    permissionPreset: workspace-write     # 显式固定；不写则不改会话原有策略
```

Ask the user for their **open_id** first (`feishu_channel_status` does not expose it; the
easiest path is to have them send one message with `allowedUsers` empty, read the sender
id from `feishu-inbound.log`, then set the allowlist). An empty `allowedUsers` is not
"open to everyone": the first sender binds the channel and later senders are refused —
but that still lets a stranger take it, so prefer listing the open_id up front. The WeChat
bundles do this automatically: the account that scanned the QR is written as the owner at
login.

The three defaults are security-relevant, so state them when you enable inbound:

| Default | Meaning |
|---|---|
| `inboundEnabled: false` | nothing listens until the user opts in |
| `allowedUsers: []` | first sender (Feishu) / logged-in account (WeChat) becomes owner. Not "open to everyone", but not a safe default either: whoever speaks first in a chat that was forwarded or added to a group becomes the owner. Prefer listing the open_id. |
| `permissionPreset: workspace-write` + `applyPermissionPreset: true` | writes stay inside the workspace. The preset also carries `approval: ask`; the plugin now answers that in the chat (see below), so an out-of-workspace action asks instead of silently escalating. `danger-full-access` removes both the confinement and the prompt; a deployment that needs unattended out-of-workspace writes sets it explicitly. **Empty (the default) means "do not touch":** the session keeps whatever policy it already has, so an upgrade never changes existing behaviour. A schema default here once silently downgraded every profile that never set it (issue #4, fixed in 0.9.37). |
| `approvalPrompts: true` + `approvalTimeoutSeconds: 300` | an approval that needs permission is asked in the chat — **as an interactive card on Feishu** (buttons `允许这一次` / `拒绝`, patched in place once settled) and as a numbered text prompt on WeChat. Text replies still work on both. No reply past the timeout counts as refused — silence is never consent. Anything other than a clear yes/no is left to the agent as an ordinary message. |

## 5. What the user will see

- the agent's answer streams into a reply card (headerless, **default width** — `fill`
  leaves only the top corners rounded, so the shape reads as cut off; footer flips from
  `流式输出中` to `完成`) — **unless `answerMode: native`**, in which case the card keeps
  only the progress line and every step's answer leaves as its own native `post` message:
  copyable, searchable, forwardable, and a multi-step turn reads as several messages in
  order. `providers/post.js` converts Markdown to `post` elements, and `finalizeTurn`
  closes such a card with an empty body so the answer is never replayed into it. A
  `post` message has **no table element** (only cards do), so a markdown table degrades
  to `列1 → 列2` lines with a bold header; code blocks, bold, links and `_italic_`
  survive. `snake_case` identifiers must not become italic — the emphasis pattern is
  word-boundary anchored for that reason. Closing such a card moves **only the footer**
  (`note_1` → 完成): writing an empty body is rejected by Feishu with
  `99992402 field validation failed`, which aborts the close and leaves the card frozen
  on 回复中 — a real symptom seen on 2026-11-23;
- a separate **thinking process** message shows reasoning and tool calls (native CoT);
- the acknowledgement reaction (`reactions`, default **on**) puts a `THINKING` emoji on the
  user's own message while the turn runs. Its only job is the one or two seconds before
  the streaming card exists; after that it duplicates the card, so a user who finds it
  noisy turns it off with `reactions: false` and loses only that brief confirmation;
- slash commands: `/help`, `/status`, `/why`, `/new`, `/rename`, `/stop`, `/model`, `/think`.
  `/why` answers with live state in one line (`正在执行 read_file · 42s · 正常`); it is
  intercepted before the model, so it also works while a turn is running. `/status`
  carries the upgrade notice: `lib/update.js` asks the registry for `latest` at most
  once a day (cached in `<DSH_HOME>/<slug>-update.json`, every failure silent) and the
  status shows `新版本：X 可用（当前 Y）`. It **never updates itself** — the user
  upgrades from DSH's Plugins page, because an upgrade can break a session in use;

## 6. Verification checklist — do all of it

1. `feishu_channel_status` → `configured: true`, `tokenOk: true`, `inboundReady: true`.
2. The user sends one message from Feishu; the answer arrives as a card, and the
   conversation appears under the `飞书` workspace in the GUI (title set, preset
   `danger-full-access`).
3. `feishu-inbound.log` shows `inbound delivered` and `card closed` with `updates > 0`.
4. `/help` replies with the command list and produces **no** model turn.
5. `/model` and `/think` list the current route and effort; switching one is reflected on
   the next turn.

If any step fails, read the log before changing configuration:
`~/.dsh/feishu-inbound.log` (JSONL, one record per step).

## 7. Report back to the user

Tell them, in this order:

- the app id you configured (never the secret), the workspace path, and whether inbound
  is on;
- which checks in §6 passed;
- what they must still do (e.g. publish the app version, add a scope, set the allowlist);
- how to stop it: set `enabled: false` (tools off) or `inboundEnabled: false` (no
  connection), or disable the bundle.

## 8. Stability semantics (so you do not mis-diagnose)

- **History is not replayed.** A long connection receives only events from the moment it
  is established. Messages sent while DSH was off are not delivered later; the user must
  resend, or you must read the chat through the API.
- **Duplicates are suppressed.** Inbound `event_id` values are deduplicated and persisted
  in the channel state file, so a reconnect or restart cannot deliver the same event
  twice. The last 400 ids are kept.
- **One client per app.** Feishu's long connection is clustered: if two processes connect
  with the same app, each event is delivered to only one of them at random. Never run a
  second DSH (or another bot framework) against the same app id; use a second app.
- **Switching from another bot.** If the app was already connected by a third-party
  framework, stop that framework first, or the two clients will steal each other's
  events. Binding a *different* app to this plugin is safe: sessions and chat memory are
  keyed per app-independent session id, and the old app's channels are untouched.
- **Rate limits are real.** Feishu returns `230020` when a chat is written too fast; the
  card writer stays at ~200 ms per update, backs off 2 s on that error, and retries the
  final close once. Do not lower the interval.
- **One writer per card.** CardKit numbers writes per card entity: a write whose `sequence`
  is not greater than the last applied one fails with `300317 sequence number compare
  failed`. The streaming flush and the turn's closing write must never be in flight at the
  same time, so the plugin chains every write to one card. If the close loses that race
  the turn falls back to re-posting the answer, and the chat shows two cards.
- **A reconnect can come back deaf.** The SDK's `onReconnected` reports a socket that
  answers pings but no longer receives events; outbound REST keeps working, so nothing
  looks broken. Two guards cover it: a reconnect that sees no inbound event for three
  minutes rebuilds the client, and while connected the plugin polls the chat history every
  two minutes (`reconcile`). Both rely on the message-id dedupe, so a rebuilt connection
  cannot answer the same message twice.
- **Connection news is throttled, not streamed.** A drop has to last 90 s before the chat
  is told (every drop seen so far healed in 8–24 s); the "recovered" card is sent only when
  the drop was announced, so a self-healing blip produces no message at all. Connection
  notices share a 10-minute floor, and three drops inside a 10-minute window collapse into a
  single "connection unstable" card instead of a pair per drop.
- **WeChat has no history API, so it fakes one with saved cursors.** `getUpdates` ignores
  an empty cursor's backlog but DOES answer an older cursor with the messages it already
  passed (verified live), so `saveWechatCursor` keeps one cursor per minute for two days
  and `listRecentMessages` cold-reads the cursor that predates the reconcile window. That
  closes the gap the Feishu catch-up covers through the messages API. The cold read never
  writes the live cursor back, and it is throttled to one call per five minutes.
- **The catch-up poll follows activity, not a fixed clock.** One `reconcile` run costs
  one base-API call; a free/standard Feishu tenant allows 10,000 a month shared across
  all self-built apps, so a flat 2-minute poll (21,600/month) empties the quota in about
  fourteen days and then *every* call fails with `99991403` (issue #6). `nextReconcileDelay`
  returns 2 min while the chat is active (inbound within 10 min), 10 min while warm
  (within an hour), and 30 min cold. The look-back window is independent: only the
  interval spends quota. **WeChat keeps the flat 2-minute loop**: its cold read is already
  rate-limited inside the provider (`COLD_READ_MIN_GAP_MS`), and slowing its catch-up
  would delay recovery without saving a documented budget.
  `feishu_channel_status` reports today's count and the current interval, so a user can
  see the burn rate before the quota runs out;
- **CoT events are byte-bounded.** The platform counts UTF-8 bytes; a long Chinese
  reasoning block must be chunked (the plugin does this). `10001 event[N] content too
  long` means the payload exceeded the budget.
- **A plain-text channel (WeChat) gets progress on a cadence, not a stream.** With no
  editable message there is no card to update, so `providers/text-stream.js` pushes one
  bubble after `textProgressSeconds` (30 s), then one per gap (180 s), at most three per
  turn. The `/why` hint lives **only** on the first WeChat bubble (`· /why 看状态`): a
  plain-text chat otherwise never discovers the command, while a Feishu card is already
  updating and must stay terse — do not put the hint into `progressText`, which both
  channels share. Two traps live here: a dedupe key that strips the elapsed time makes
  every later bubble look identical and suppresses the cadence entirely (that was the
  bug where only the 30 s bubble ever appeared), and the WeChat row loads a **generated
  copy** (`dsh-channel-wechat`), so editing the source alone leaves WeChat on old code —
  run `build-wechat.mjs` (or `sync-check.ps1` will report it).

## 9. How this differs from other Feishu plugins (tell the user if they ask)

- **No prompt injection**: the inbound message is delivered verbatim; no chat id, no
  "answer with tool X" preamble, so the conversation log stays clean.
- **Binds the session the user already sees** (desktop profile, `飞书` workspace,
  auto-named, unattended preset) instead of running a separate headless process.
- **Native thinking process** (Feishu CoT) plus streaming card, reactions and slash
  commands, in one small dependency-light package.
