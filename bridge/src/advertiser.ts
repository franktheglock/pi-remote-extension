export interface AdvertiseTarget {
  name: string;
  port: number;
  token: string;
  hostname: string;
  ip?: string;
}

/**
 * Advertises this computer over mDNS/Bonjour as `_pirmote._tcp` so the Pi Remote
 * iPhone app can discover it automatically (no manual IP entry).
 *
 * `bonjour-service` is imported lazily — it can be slow or unavailable on some
 * machines (and is a no-op on a headless box), so it must never block or crash
 * bridge startup.
 *
 * The token is placed in the TXT record only while advertising is enabled — i.e.
 * after you explicitly run `/remote` (opt-in). Keep this on a trusted LAN/VPN.
 */
export class Advertiser {
  private bonjourCtor: any = null;
  private bonjour: any = null;
  private service: any = null;
  private target: AdvertiseTarget | null = null;
  private _enabled = false;
  private publishing = false;

  get enabled(): boolean {
    return this._enabled;
  }

  setTarget(target: AdvertiseTarget): void {
    this.target = target;
    if (this._enabled) void this.publish();
  }

  enable(): void {
    this._enabled = true;
    void this.publish();
  }

  disable(): void {
    this._enabled = false;
    this.teardown();
  }

  stop(): void {
    this.disable();
  }

  private async publish(): Promise<void> {
    if (this.publishing) return;
    this.publishing = true;
    try {
      this.teardown();
      if (!this.target) return;

      if (!this.bonjourCtor) {
        const mod: any = await import("bonjour-service");
        this.bonjourCtor = mod?.default ?? mod;
      }
      // Bail if advertising was toggled off while the import was in flight.
      if (!this._enabled || !this.target) return;

      this.bonjour = new this.bonjourCtor();
      this.service = this.bonjour.publish({
        name: `Pi Remote · ${this.target.hostname}`,
        type: "pirmote",
        port: this.target.port,
        txt: {
          ver: "0.1.0",
          name: this.target.name,
          host: this.target.hostname,
          ip: this.target.ip ?? "",
          port: String(this.target.port),
          path: "/app",
          proto: "ws",
          token: this.target.token, // opt-in when advertising; LAN/VPN only
        },
      });
    } catch (err) {
      console.error("[advertiser] mDNS advertising unavailable:", (err as Error)?.message ?? err);
    } finally {
      this.publishing = false;
    }
  }

  private teardown(): void {
    try {
      this.service?.stop?.();
    } catch {
      /* ignore */
    }
    try {
      this.bonjour?.destroy?.();
    } catch {
      /* ignore */
    }
    this.service = null;
    this.bonjour = null;
  }
}
