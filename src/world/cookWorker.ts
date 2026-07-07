import { cookColliderBoxes } from "./cook";

// Off-thread cooking worker. Imports the SAME pure ./cook module the main thread uses, so a cooked chunk
// is byte-identical whether it was cooked here or inline (determinism by construction). Receives a chunk's
// voxel keys (transferred), returns the greedy collider boxes (transferred back) — no RAPIER/THREE here.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

ctx.onmessage = (e: MessageEvent) => {
  const { kind, ck, gen, keys } = e.data as { kind: string; ck: number; gen: number; keys: Int32Array };
  if (kind === "collider") {
    const boxes = cookColliderBoxes(keys);
    ctx.postMessage({ kind, ck, gen, boxes }, [boxes.buffer]);
  }
};
