/** Thin client for the relay server. Sends/receives JSON messages tagged with a per-player id. */
export type NetMsg = Record<string, unknown> & { t: string; id?: number };

export class Net {
  id = 0;
  connected = false;
  onMessage?: (msg: NetMsg) => void;
  onState?: (open: boolean) => void;
  private ws: WebSocket | null = null;

  /** Connects to the relay for `room`. URL resolution: explicit ?net= wins; on localhost the relay is a
   *  separate `npm run relay` on :8787; in production it's served SAME-ORIGIN by server/relay.mjs, so we
   *  use wss://<this host> (works on Render/any HTTPS host without extra config). */
  connect(room: string): void {
    const params = new URLSearchParams(location.search);
    let base = params.get("net");
    if (!base) {
      const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
      base = local
        ? `ws://${location.hostname}:8787`
        : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
    }
    const url = `${base}${base.includes("?") ? "&" : "?"}room=${encodeURIComponent(room)}`;
    try {
      this.ws = new WebSocket(url);
    } catch {
      return;
    }
    this.ws.onopen = () => { this.connected = true; this.onState?.(true); };
    this.ws.onclose = () => { this.connected = false; this.ws = null; this.onState?.(false); };
    this.ws.onerror = () => { /* surfaced via onclose */ };
    this.ws.onmessage = (e) => {
      let msg: NetMsg;
      try { msg = JSON.parse(e.data as string); } catch { return; }
      if (msg.t === "hello" && typeof msg.id === "number") this.id = msg.id;
      this.onMessage?.(msg);
    };
  }

  send(msg: NetMsg): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
}
