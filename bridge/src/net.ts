import os from "node:os";

export interface LanAddress {
  label: string;
  ip: string;
}

/** Non-internal IPv4 addresses to advertise/enter into the app. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) {
        out.push({ label: name, ip: a.address });
      }
    }
  }
  return out;
}

export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.")
  );
}
