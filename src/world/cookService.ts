import { cookColliderBoxes, cookMeshChunk, type CookedMeshPart } from "./cook";

/**
 * Routes chunk cooking to a Web Worker (off the main thread) when one is available, and cooks INLINE
 * otherwise — the caller can't tell the difference except for latency. This is what keeps heavy
 * destruction from stalling the main thread: the ~80%-of-a-rebuild greedy cook runs off-thread; the
 * main thread only turns the returned boxes into Rapier colliders.
 *
 * Safe by construction: node/tests and worker-hostile browsers get the synchronous path (== old
 * behaviour); a per-chunk generation counter drops any result that a newer edit has superseded.
 */
export class CookService {
  private worker: Worker | null = null;
  // Per-KIND generation counters. Mesh and collider chunks now use DIFFERENT chunk sizes (64 vs 32), so
  // their packed keys live in overlapping number ranges — a shared map would let a mesh touch() spuriously
  // drop a collider result (and vice versa). Keeping one map per kind isolates them.
  private readonly gen = { mesh: new Map<number, number>(), collider: new Map<number, number>() };
  private inflight = 0;
  private static readonly MAX_INFLIGHT = 4;

  /** Called with a chunk's cooked collider boxes — synchronously in the fallback, else 1–2 frames later. */
  onColliderCooked?: (ck: number, boxes: Int32Array) => void;
  /** Called with a chunk's cooked mesh instance data (per material) — same sync/async contract. */
  onMeshCooked?: (ck: number, parts: CookedMeshPart[]) => void;

  constructor(forceSync = false) {
    if (!forceSync && typeof Worker !== "undefined") {
      try {
        this.worker = new Worker(new URL("./cookWorker.ts", import.meta.url), { type: "module" });
        this.worker.onmessage = (e) => this.receive(e.data);
        this.worker.onerror = () => { this.worker = null; }; // any worker failure → degrade to inline cooking
      } catch { this.worker = null; }
    }
  }

  /** True when cooking actually runs off-thread (a worker is live). */
  get async(): boolean { return this.worker !== null; }

  /** Bump a chunk's generation (for the given cook kind) so any in-flight cook for its OLD state is
   *  dropped when it returns. Call whenever the chunk is edited/dirtied. */
  touch(ck: number, kind: "mesh" | "collider"): void {
    const m = this.gen[kind];
    m.set(ck, (m.get(ck) ?? 0) + 1);
  }

  /**
   * Cook one chunk's colliders from a snapshot of its voxel keys. Off-thread if possible (result via
   * onColliderCooked later); otherwise inline (onColliderCooked fires synchronously, same frame).
   * `keys` is transferred to the worker — do not reuse it after calling.
   */
  requestCollider(ck: number, keys: Int32Array): void {
    if (!this.worker || this.inflight >= CookService.MAX_INFLIGHT) {
      this.onColliderCooked?.(ck, cookColliderBoxes(keys)); // synchronous fallback
      return;
    }
    this.inflight++;
    const gen = this.gen.collider.get(ck) ?? 0;
    this.worker.postMessage({ kind: "collider", ck, gen, keys }, [keys.buffer]);
  }

  /** Cook one chunk's mesh instance data. Off-thread if possible; else inline (onMeshCooked synchronous).
   *  `keys`/`matIdx` are transferred to the worker — do not reuse them after calling. */
  requestMesh(ck: number, keys: Int32Array, matIdx: Uint8Array): void {
    if (!this.worker || this.inflight >= CookService.MAX_INFLIGHT) {
      this.onMeshCooked?.(ck, cookMeshChunk(keys, matIdx)); // synchronous fallback
      return;
    }
    this.inflight++;
    const gen = this.gen.mesh.get(ck) ?? 0;
    this.worker.postMessage({ kind: "mesh", ck, gen, keys, matIdx }, [keys.buffer, matIdx.buffer]);
  }

  private receive(msg: { kind: string; ck: number; gen: number; boxes?: Int32Array; parts?: CookedMeshPart[] }): void {
    this.inflight--;
    const g = msg.kind === "mesh" ? this.gen.mesh : this.gen.collider;
    if ((g.get(msg.ck) ?? 0) !== msg.gen) return; // stale: the chunk changed since the request → still dirty, re-queued
    if (msg.kind === "collider") this.onColliderCooked?.(msg.ck, msg.boxes!);
    else if (msg.kind === "mesh") this.onMeshCooked?.(msg.ck, msg.parts!);
  }
}
