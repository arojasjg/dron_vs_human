export class Input {
  private keys = new Set<string>();
  private mdx = 0;
  private mdy = 0;
  locked = false;

  onMouseDown?: (button: number) => void;
  onMouseUp?: (button: number) => void;
  onWheel?: (deltaSign: number) => void;
  onKey?: (code: string) => void;

  constructor(canvas: HTMLElement) {
    window.addEventListener("keydown", (e) => {
      const code = e.code.toLowerCase();
      if (!this.keys.has(code)) this.onKey?.(code);
      this.keys.add(code);
      if (code === "tab") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code.toLowerCase()));

    canvas.addEventListener("mousedown", (e) => {
      if (!this.locked) {
        canvas.requestPointerLock();
        return;
      }
      this.onMouseDown?.(e.button);
    });
    window.addEventListener("mouseup", (e) => {
      if (this.locked) this.onMouseUp?.(e.button);
    });
    window.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mdx += e.movementX;
      this.mdy += e.movementY;
    });
    window.addEventListener("wheel", (e) => {
      if (this.locked) this.onWheel?.(Math.sign(e.deltaY));
    }, { passive: true });
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  consumeMouseDelta(): { x: number; y: number } {
    const d = { x: this.mdx, y: this.mdy };
    this.mdx = 0;
    this.mdy = 0;
    return d;
  }
}
