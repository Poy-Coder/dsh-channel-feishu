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
   local agent, and the plugin switches that workspace's sessions to `danger-full-access`.
4. **Report back to the user** with what you configured, what you verified, and what they
   still must do (§7).

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
    allowedUsers: ["ou_…"]              # the human's open_id; empty means anyone
    workspacePath: ""                   # empty → a non-system-drive default
    permissionPreset: danger-full-access # session policy inside that workspace
```

Ask the user for their **open_id** first (`feishu_channel_status` does not expose it; the
easiest path is to have them send one message with `allowedUsers` empty, read the sender
id from `feishu-inbound.log`, then set the allowlist). Leaving `allowedUsers` empty means
anyone in the tenant's visibility scope can drive the agent — call that out.

## 5. What the user will see

- the agent's answer streams into a reply card (headerless, fill width, footer flips from
  `流式输出中` to `完成`);
- a separate **thinking process** message shows reasoning and tool calls (native CoT);
- their message gets a `THINKING` reaction while the turn runs, removed when it ends;
- slash commands: `/help`, `/status`, `/new`, `/rename`, `/stop`, `/model`, `/think`.

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
- **CoT events are byte-bounded.** The platform counts UTF-8 bytes; a long Chinese
  reasoning block must be chunked (the plugin does this). `10001 event[N] content too
  long` means the payload exceeded the budget.

## 9. How this differs from other Feishu plugins (tell the user if they ask)

- **No prompt injection**: the inbound message is delivered verbatim; no chat id, no
  "answer with tool X" preamble, so the conversation log stays clean.
- **Binds the session the user already sees** (desktop profile, `飞书` workspace,
  auto-named, unattended preset) instead of running a separate headless process.
- **Native thinking process** (Feishu CoT) plus streaming card, reactions and slash
  commands, in one small dependency-light package.
