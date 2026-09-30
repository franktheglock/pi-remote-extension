#!/usr/bin/env node
import os from "node:os";
import { startServer, loadOrCreateToken } from "./server.js";
import { lanAddresses } from "./net.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const host = arg("host", process.env.PI_REMOTE_HOST ?? "0.0.0.0")!;
const port = Number(arg("port", process.env.PI_REMOTE_PORT ?? "8877"));
const token = loadOrCreateToken(arg("token"));

async function main(): Promise<void> {
  const { close, advertiser } = await startServer({ host, port, token });
  void advertiser;

  const addrs = lanAddresses();
  const W = 60;
  const row = (s = "") => `│ ${s.padEnd(W - 2)} │`;
  const line = "─".repeat(W);
  console.log(`\n┌${line}┐`);
  console.log(row("Pi Remote Bridge  v0.1.0"));
  console.log(`├${line}┤`);
  console.log(row(`Status:  listening on ${host}:${port}`));
  console.log(row(`Apps connected: 0`));
  console.log(`├${line}┤`);
  console.log(row("Enter these in the Pi Remote iPhone app:"));
  for (const a of addrs.slice(0, 4)) {
    console.log(row(`  IP     ${a.label.padEnd(8)} ${a.ip}`));
  }
  console.log(row(`  Token  ${token}`));
  console.log(`└${line}┘\n`);
  console.log(`Tip: run 'pi' anywhere on this machine — the pi-remote extension`);
  console.log(`     will auto-connect each session to this bridge.\n`);
  if (flag("show-token")) console.log(`TOKEN=${token}\n`);

  const shutdown = async () => {
    console.log("\nShutting down Pi Remote bridge…");
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Pi Remote bridge failed to start:", err);
  process.exit(1);
});
