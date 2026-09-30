# Pi Remote — pi extension + bridge

Control your [pi](https://github.com/earendil-works/pi-coding-agent) sessions from your
phone. This repo is the **host side**:

- **`extension/pi-remote/`** — a pi extension that streams a session's live status
  (working / needs-input / complete), accepts remote commands (chat, steer, abort,
  model + reasoning switching), forwards image attachments, and provides the
  **`/remote`** slash command that prints a pairing QR code.
- **`bridge/`** — a small Node daemon that aggregates this machine's pi sessions and
  exposes one token-authenticated LAN/VPN endpoint (WebSocket + HTTP), with Bonjour
  (`_pirmote._tcp`) discovery, on-disk history, and usage stats (tokens/cost/model).

> The iOS app is a separate, private project.

## Install the extension

```bash
mkdir -p ~/.pi/agent/extensions
cp -R extension/pi-remote ~/.pi/agent/extensions/pi-remote
cd ~/.pi/agent/extensions/pi-remote && npm install
```

Every `pi` session then connects to the bridge automatically.

## Run the bridge (once per computer)

```bash
cd bridge
npm install
npm start            # or: npm run dev  (tsx, no build needed)
```

It prints the **IP**, **port**, and an access **token** (stored in `~/.pi-remote/token`),
and listens on `0.0.0.0:8877` — so it works over your LAN and a VPN like Tailscale.

## Pair

In any pi session run **`/remote`** → it starts/verifies the bridge, turns on Bonjour
advertising, and shows a **QR code** + pairing card. Scan it (or enter the IP + token)
in the app. `/remote` subcommands: `status`, `pair`, `hide`, `advertise on|off`,
`token`, `restart`.

## Platform support

Plain Node.js, no native modules — runs on **macOS, Linux, and Windows**.

- **Node 22+** required (the extension uses the global `WebSocket`).
- **Windows:** `/remote` auto-start runs `.cmd` shims through a shell and falls back to
  `npx --yes pi-remote-bridge`; Bonjour/mDNS discovery may be blocked by the firewall
  (manual IP / QR still work).
- Point the extension at a specific binary with
  `PI_REMOTE_BRIDGE_BIN=/abs/path/bridge/dist/bridge/src/index.js`.

## Protocol

`shared/protocol.ts` defines every message exchanged between the extension, the bridge
and the app.

## License

MIT
