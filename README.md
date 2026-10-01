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

## Quick install with your agent

Paste this into pi (or any coding agent with a shell) on the computer you want to control:

```text
Set up Pi Remote on this computer so I can control my pi sessions from my iPhone.
Project: https://github.com/franktheglock/pi-remote-extension

1. Check prerequisites: `node --version` must be 22 or newer, and `pi` must be on
   my PATH. If either is missing, stop and tell me what to install.
2. Install the extension as a pi package:
   pi install git:github.com/franktheglock/pi-remote-extension
   If it is already installed, run `pi update --extensions` instead.
3. Do not start the bridge yourself and do not build anything. The extension
   starts the bridge the first time I run /remote.
4. Check whether a bridge is already running:
   curl -s http://127.0.0.1:8877/health
   Tell me whether it answered. No answer is fine at this point.
5. Tell me to do these two things myself, since they are pi slash commands you
   can't run for me:
   - run /reload in each open pi session (or start a new one)
   - run /remote, then scan the QR code it shows with the Pi Remote iPhone app

Rules:
- Don't print, log, or copy my pairing token anywhere (it lives in ~/.pi-remote/token).
- Don't change firewall, router, or VPN settings, and don't expose port 8877 to
  the internet. If something is blocked, tell me what and let me decide.
- On Windows, use PowerShell and `curl.exe` instead of `curl`.
- If a step fails, show me the exact error and stop instead of trying workarounds.

When you're done, give me a short summary: what you installed, whether the
bridge answered, and what I need to do next.
```

Prefer to do it by hand? The same steps are below.

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
or, if installed as a pi package, `pi update --extensions`.

The **bridge** is a separate, long-running process, so it keeps running the old code until
it restarts. After updating, run `/reload` and then **`/remote`** in pi: the extension notices
the bridge is older than the code on disk and restarts it. `/remote restart` forces a restart.
If you started the bridge yourself (`npm run dev`), restart it yourself.

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

## Support

If the Pi Remote iPhone app isn't connecting to this bridge, or something
else isn't working:

1. Check **Pair** above — most issues are a wrong host/port or a stale token
   (run `/remote` again to see the current QR and token).
2. Make sure iPhone and computer are on the same network (or the same
   Tailscale tailnet), and the bridge is up: `curl http://<host>:8877/health`.
3. Still stuck? [Open an issue](https://github.com/franktheglock/pi-remote-extension/issues)
   with your bridge log, iOS version, and what the app shows — or reinstall with
   `update.sh` and `/reload` first, since most reports turn out to be a stale
   bridge or extension copy.

## License

MIT
