import { describe, it, expect } from "vitest";
import { netStatusLabel, type NetStatus } from "../src/net/net";

// The HUD connection indicator maps each socket state to a Spanish label + a CSS state class. Pure mapping,
// no DOM/three.js — so it unit-tests directly.
describe("netStatusLabel", () => {
  it("connecting → amber label + connecting class", () => {
    expect(netStatusLabel("connecting")).toEqual({ label: "🟡 Conectando…", cls: "connecting" });
  });
  it("connected → green label + connected class", () => {
    expect(netStatusLabel("connected")).toEqual({ label: "🟢 Conectado", cls: "connected" });
  });
  it("lost → red label + lost class", () => {
    expect(netStatusLabel("lost")).toEqual({ label: "🔴 Conexión perdida", cls: "lost" });
  });
  it("offline → EMPTY label (indicator hides) + offline class", () => {
    expect(netStatusLabel("offline")).toEqual({ label: "", cls: "offline" });
  });

  it("the three live-state classes are all distinct", () => {
    const live: NetStatus[] = ["connecting", "connected", "lost"];
    const classes = live.map((s) => netStatusLabel(s).cls);
    expect(new Set(classes).size).toBe(3);
  });
});
