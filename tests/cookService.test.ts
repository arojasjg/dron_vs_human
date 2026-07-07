import { describe, it, expect } from "vitest";
import { CookService } from "../src/world/cookService";
import { cookColliderBoxes } from "../src/world/cook";
import { packKey } from "../src/world/voxelGrid";

describe("CookService — synchronous fallback (node / worker-less)", () => {
  it("cooks inline and delivers the correct boxes for the right chunk", () => {
    const svc = new CookService(true); // force the no-worker path
    expect(svc.async).toBe(false);
    const raw = [packKey(0, 0, 0), packKey(1, 0, 0), packKey(0, 1, 0)];
    let gotCk = -1; let got: Int32Array | null = null;
    svc.onColliderCooked = (ck, boxes) => { gotCk = ck; got = boxes; };
    svc.requestCollider(42, Int32Array.from(raw));
    expect(gotCk).toBe(42);
    expect([...got!]).toEqual([...cookColliderBoxes(raw)]);
  });

  it("an empty chunk cooks to empty boxes", () => {
    const svc = new CookService(true);
    let got: Int32Array | null = null;
    svc.onColliderCooked = (_ck, b) => { got = b; };
    svc.requestCollider(7, new Int32Array(0));
    expect(got!.length).toBe(0);
  });
});
