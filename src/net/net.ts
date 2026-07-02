/** Thin client for the relay server. Sends/receives JSON messages tagged with a per-player id. */
export type NetMsg = Record<string, unknown> & { t: string; id?: number };

export class Net {
  id = 0;
  connected = false;
  onMessage?: (msg: NetMsg) => void;
  onState?: (open: boolean) => void;
  private ws: WebSocket | null = null;

  /** Connects to `ws://host:port?room=CODE`. Resolves the relay URL from ?net= or localhost. */
  connect(room: string): void {
    const params = new URLSearchParams(location.search);
    const base = params.get("net") || `ws://${location.hostname || "localhost"}:8787`;
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
