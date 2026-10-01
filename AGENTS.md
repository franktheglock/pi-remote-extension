# Pi Remote extension — agent guide

A [pi](https://github.com/earendil-works/pi-coding-agent) extension plus a small bridge server that let the
Pi Remote iPhone app view and control pi sessions running on a computer.

```
extension/pi-remote/index.ts   the pi extension: streams session state, handles remote commands, /remote command
bridge/                        Node server (port 8877) that aggregates sessions on this computer for the app
shared/protocol.ts             wire types shared by the extension, the bridge and the app
update.sh                      update helper for manual installs
package.json                   declares the extension so `pi install` can load it
```

pi (with the extension) ⇄ bridge ⇄ phone app over WebSocket, authenticated by a token in `~/.pi-remote/token`.

## Working in this repo

- This repo is published from the project's main repository. Edits made only here can be overwritten by the next
  sync, so keep changes small and self-contained, and expect them to be carried back.
- Plain Node.js, TypeScript, **Node 22+**. No native modules. Must run on macOS, Linux and Windows.
- Typecheck before committing (both must report 0 errors):
  ```
  cd bridge && npm install && ./node_modules/.bin/tsc --noEmit -p .
  cd ../extension/pi-remote && ../../bridge/node_modules/.bin/tsc --noEmit -p tsconfig.json
  ```
- Run the bridge in dev with `cd bridge && npm run dev`. Test against a **throwaway instance**, not a bridge people are
  using: `PI_REMOTE_PORT=8899 PI_REMOTE_HOST=127.0.0.1 PI_REMOTE_HOME=<scratch dir> PI_REMOTE_TOKEN=test npx tsx src/index.ts`,
  then drive it with a short `ws` script (`/app` expects `{type:"hello",token}` first; `/ext` takes `register`).
- To try an extension change in a local pi: copy `extension/pi-remote/index.ts` to `~/.pi/agent/extensions/pi-remote/`
  and run `/reload`.

## Compatibility rules

- `shared/protocol.ts` is a contract with released phone apps. Add optional fields; don't remove or rename existing ones.
  The pairing string (`pi-remote://connect?host=&port=&token=&name=&alt=&tls=`) must stay parseable by older apps —
  unknown query items are ignored, so add rather than change.
- The bridge is a separate long-running process: after changing it, restart it (`/remote restart`). The extension
  restarts a bridge whose code is older than the files on disk. Running pi sessions need `/reload` to load a new extension.

## Things that will bite you

- **Secrets:** never print, log or commit the token or a pairing string. Redact them in output and examples.
- **Don't start a second pi on a session that's already open.** The bridge refuses (`~/.pi-remote/open/<id>.pid` markers);
  keep that guard intact.
- **Windows:** `cmd.exe` quoting differs from POSIX. Terminal launching in `bridge/src/launch.ts` passes the command
  line verbatim on purpose — test changes with that in mind.
- pi truncates string-array widgets to 10 lines; the pairing card is a component for that reason. The QR is drawn with
  background colours, not block glyphs, so it scans in any terminal font — keep it that way.
- Keep `README.md` user-facing and accurate when behaviour or commands change.

## Commits

Small, descriptive commits (title line, then bullets for what changed and why). Commit and push only when asked.
