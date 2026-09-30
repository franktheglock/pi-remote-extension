# Pi Remote — pi extension + bridge

Control your [pi](https://github.com/earendil-works/pi-coding-agent) sessions from your
phone. This repo is the **host side** (the iOS app is a separate, private project).

- **`extension/pi-remote/`** — a pi extension that streams a session's live status
  (working / needs-input / complete), thinking and tool calls to the bridge, accepts remote
  commands (chat, steer, abort, model + reasoning switching, image attachments), and
  provides the **`/remote`** slash command that prints a pairing QR code.
- **`bridge/`** — a small Node daemon that aggregates this machine's pi sessions and exposes
  one token-authenticated LAN/VPN endpoint (WebSocket + HTTP). It advertises over Bonjour
  (`_pirmote._tcp`), serves full on-disk history, computes **usage stats** (tokens / cost /
  model), and can **launch new pi sessions** in a chosen folder.

```
┌───────────────────────────┐        ws(s)://IP:8877/app       ┌────────────────┐
│ Computer (pi sessions)     │ ◄──────────────────────────────► │  iPhone app     │
│  extension ⇄ bridge  ◄─────│── Bonjour _pirmote._tcp + QR ───│  (private)      │
└───────────────────────────┘                                   └────────────────┘
```

## Install the extension

**As a pi package (recommended — `pi update --extensions` works):**

```bash
pi install git:github.com/franktheglock/pi-remote-extension
pi update --extensions        # later
```

**Or copy the folder manually:**

```bash
mkdir -p ~/.pi/agent/extensions
cp -R extension/pi-remote ~/.pi/agent/extensions/pi-remote
cd ~/.pi/agent/extensions/pi-remote && npm install
```

Then **`/reload`** in pi (or start a new session).

## Run the bridge (once per computer)

```bash
cd bridge
npm install
npm run dev        # tsx, no build step — or: npm run build && npm start
```

It prints the **IP**, **port**, and an access **token** (stored in `~/.pi-remote/token`), and
listens on `0.0.0.0:8877` — so it works over your LAN and a VPN like Tailscale.

## Pair

In any pi session run **`/remote`** → it starts/verifies the bridge, turns on Bonjour
advertising, and shows a **QR code** + pairing card. Scan it (or enter the IP + token) in
the app.

`/remote` subcommands: `status`, `pair`, `hide`, `advertise on|off`, `token`, `restart`.

## What the bridge exposes

- **Sessions** — live sessions (via the extension) and every session on disk (`~/.pi/agent/sessions`).
- **History** — full transcript for any session, with tool args, diffs, thinking and timestamps.
- **Control** — prompt / steer / follow-up / abort / rename / set model / set thinking level.
- **Stats** — tokens, cost, and per-model usage for day / week / month / year and all-time.
- **Filesystem + launch** — browse directories and start a new pi session in a chosen folder.
- **Discovery** — Bonjour `_pirmote._tcp` (token included while advertising is on).

## Updating

```bash
./update.sh          # git pull + npm install + install the extension folder
```
or, if installed as a pi package, `pi update --extensions`. The **bridge** is a separate
process — restart it after `git pull && npm install`.

> `pi update --extensions` only updates extensions pi installed as *packages*. A folder you
> copied in by hand isn't tracked — use `update.sh` or re-copy the folder, then `/reload`.

## Platform support

Plain Node.js, no native modules — runs on **macOS, Linux, and Windows**.

- **Node 22+** required (the extension uses the global `WebSocket`).
- **Windows:** `/remote` auto-start runs `.cmd` shims through a shell and falls back to
  `npx --yes pi-remote-bridge`; Bonjour/mDNS discovery may be blocked by the firewall
  (manual IP / QR still work).
- Point the extension at a specific binary with
  `PI_REMOTE_BRIDGE_BIN=/abs/path/bridge/dist/bridge/src/index.js`.

## Security

Everything is token-gated and meant for a **trusted LAN or VPN** — do **not** expose the
bridge port to the internet. Running `/remote` (and therefore Bonjour advertising) is an
explicit opt-in; `/remote advertise off` stops broadcasting the token.

## Protocol

`shared/protocol.ts` defines every message exchanged between the extension, the bridge and
the app.

## License

MIT
