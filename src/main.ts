import RAPIER from "@dimforge/rapier3d-compat";
import { Game } from "./game";
import { detectGpu } from "./engine/capabilities";

async function boot(): Promise<void> {
  await RAPIER.init();
  void detectGpu();
  document.getElementById("loading")?.remove();
  const container = document.getElementById("app")!;
  const game = new Game(container);
  game.start();
  (window as unknown as { __particles?: Game }).__particles = game;
}

boot();
