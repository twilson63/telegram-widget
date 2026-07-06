# Telegram Widget for HyperDesk

A HyperDesk widget that lets you chat with your Pi agent from Telegram.

## What It Is

A sandboxed HyperDesk widget (right panel) paired with a local Telegram bridge daemon (Node.js + [grammy](https://grammy.dev)). The daemon polls the Telegram Bot API and relays messages to/from your HyperDesk agent.

```
Telegram ──Bot API──→ Bridge Daemon (Node.js)
                         │
                         │  WebSocket (localhost:18765)
                         │
                   HyperDesk Widget (right panel)
                         │
                         │  agent.dispatch()
                         │
                   Pi Agent (background session)
```

## What It Is Not

- Not a bot platform or multi-user service
- Not hosted — everything runs on your machine
- Not a webhook receiver — uses long-polling (no public URL needed)
- No persistent history across restarts (v1)

## First-Run Setup

### 1. Create a Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### 2. Install the Widget

Install it with HyperDesk's widget installer. In this project, the agent can install it directly with `install_widget`; manually dropping this source folder into the project directory will not load it. The installed layout is:

```
~/.hyperdesk/widgets/tom.telegram/
├── hyperdesk.extension.json
├── ui/
│   ├── index.html
│   ├── hyperdesk-widget.js
│   └── hyperdesk-widget.d.ts
├── scripts/
│   ├── telegram-bridge.cjs
│   ├── package.json
│   └── node_modules/   (contains grammy)
└── README.md
```

The installed widget lives at `~/.hyperdesk/widgets/tom.telegram/` and appears under **View → Widgets → Telegram**. If that folder does not exist, the widget is not installed yet.

### 3. Configure

1. Open HyperDesk → View → Widgets → **Telegram**
2. Go to the **Config** tab
3. Paste your bot token in the **Bot Token** field
4. (Optional) Set a Chat ID allowlist — leave blank for permissive mode (first user who types `/start` becomes the owner)
5. Click **Start Bridge** — you'll see an approval prompt for `command.run`
6. Confirm. The widget starts a local daemon, then sends the bot token to it over `ws://127.0.0.1:18765` so the token does not appear in the shell command, approval prompt, process list, or bridge logs.
7. Send `/start` to the bot in Telegram.

That's it. Send any message on Telegram to chat with your agent.

## Tabs

### Chat
- Message history styled like Telegram
- Agent responses in blue bubbles (right), your messages in gray (left)
- Shows "Agent is typing..." while processing
- Connection status indicator (green = running, gray = stopped, red = error)

### Config
- Bot Token (password field)
- Chat ID allowlist (optional)
- Start / Stop buttons
- Connection status readout

### Status
- Bridge process info, WebSocket port, uptime
- Message counters (received/sent)
- Event log with timestamps

## Telegram Commands

| Command | Effect |
|---------|--------|
| `/start` | Confirm connection, begin polling |
| `/stop`  | Stop polling |
| `/status` | Show uptime, message counts |
| `/help` | List available commands |
| *Anything else* | Forwarded to HyperDesk agent |

## How It Works

### Data Flow

1. **You message the bot** on Telegram
2. Bridge daemon polls Telegram, receives your message
3. Bridge validates chat ID against allowlist (silently drops unauthorized)
4. Bridge sends message to widget via WebSocket
5. Widget dispatches to agent via `widget.agent.dispatch()`
6. Agent streams output back → widget collects → sends to bridge via WebSocket
7. Bridge splits long responses into chunks (≤3500 chars) and sends as separate Telegram messages

### Conversation Memory

The bridge maintains a history of the last 20 exchanges (40 messages). Each agent dispatch includes this history so the agent has context between Telegram messages.

### Secrets

Your bot token is entered in the widget's Config tab. On start, the bridge process is launched without the token in its command line or environment; after the localhost WebSocket connects, the widget sends the token over `127.0.0.1` using a `bridge:configure` message. The token is never logged or echoed.

### Security

- **Bot token**: entered in widget UI only, sent to the daemon over localhost WebSocket, never logged
- **Chat ID allowlist**: validates incoming messages before forwarding
- **WebSocket**: binds to `127.0.0.1` only — never exposed to network
- **No webhooks**: long-polling means no public URL or ngrok tunnel needed
- **Per-user isolation**: each widget installation is fully independent

## File Structure

```
hyperdesk.extension.json   ← Widget manifest (permissions, toggle command)
ui/
├── index.html             ← Widget UI (Chat, Config, Status tabs)
├── hyperdesk-widget.js    ← HyperDesk bridge SDK
└── hyperdesk-widget.d.ts  ← TypeScript declarations
scripts/
├── telegram-bridge.cjs    ← Bridge daemon (grammy + WebSocket)
├── package.json           ← Bridge dependencies
└── node_modules/          ← Bundled grammy + transitive deps
README.md                  ← This file
```

## Permissions Explained

| Permission | Risk | Why |
|------------|------|-----|
| `agent.dispatch` | High | Sends your messages to the Pi agent, receives streamed output |
| `command.run` | High | Starts/stops the bridge daemon process (Node.js) |
| `navigator.open` | Low | Opens the BotFather help link visibly |

## Troubleshooting

### "Invalid bot token"
Double-check the token you got from BotFather. It should look like `123456:ABC-DEF1234...`. No spaces, no quotes.

### "Bridge disconnected"
The bridge auto-retries every 5 seconds. If it won't reconnect:
1. Check if another instance is running: `lsof -i :18765`
2. Stop any existing bridge: `pkill -f telegram-bridge.cjs`
3. Try starting again

### Port conflict
If port 18765 is in use, the bridge auto-increments to the next available port. Check the Status tab or the console for the actual port.

### command.run approval every time
After the first start, configure session-wide "always allow" for the bridge command to skip future prompts. Go to HyperDesk settings → Approvals.

### No response on Telegram after starting
1. Make sure the widget is installed at `~/.hyperdesk/widgets/tom.telegram/` and visible in **View → Widgets**
2. Make sure you sent `/start` to the bot in Telegram
3. Check the Chat tab — you should see the bridge connect and Telegram messages appear
4. Check the Status tab event log for errors
5. Verify your bot token is correct
6. If port 18765 is already owned by an older bridge, click **Start Bridge** again; the start command kills stale `telegram-bridge.cjs` processes before launching a fresh one.

### Agent seems to forget context
The bridge maintains the last 20 exchanges in conversation history. If the conversation gets very long, older messages drop off. This is by design to keep dispatches fast.

## Known Limitations (v1)

- **One bot, one chat**: v1 uses a single chat ID. Multi-user support is planned for v2.
- **Chunked messages**: Long responses are split into multiple Telegram messages (simpler than edit-in-place)
- **No file sharing**: Cannot send/receive files between Telegram and HyperDesk
- **No voice messages**: Text-only for now
- **command.run approval**: Starting the bridge requires approval each session (configurable as always-allow)
- **No auto-update**: Install new versions manually

## License

Private use only. Shared via ZenBin for HyperDesk users.
