// Procedural game audio over ONE Web Audio context (no external sample files → nothing to license or
// bundle, works offline/on Render). Each effect is synthesised from a reused white-noise buffer +
// oscillators shaped by exponential-decay gain envelopes. The live context also keeps the tab awake
// (see keep-alive note); it resumes on the first user gesture per the autoplay policy.
import { WEAPON_SFX, explosionParams, IMPACT_SFX, distanceGain, type SfxMaterial } from "./soundParams";

const MAT_MAP: Record<string, SfxMaterial> = {
  concrete: "concrete", brick: "brick", wood: "wood", glass: "glass", metal: "metal",
  gastank: "metal", dirt: "dirt", grass: "dirt",
};

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private muted = false;
  private rotorGain: GainNode | null = null;
  private rotorFilter: BiquadFilterNode | null = null;
  private rotorOsc: OscillatorNode | null = null;

  constructor() {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      // one reusable 2 s white-noise buffer feeds every burst/rotor
      const buf = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * 2), this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      // a silent keep-alive oscillator keeps the tab's audio (and thus the game loop) awake while hidden
      const ka = this.ctx.createOscillator(), kg = this.ctx.createGain();
      kg.gain.value = 0; ka.connect(kg); kg.connect(this.ctx.destination); ka.start();
      const resume = () => this.ctx?.resume().catch(() => {});
      if (typeof window !== "undefined") { window.addEventListener("pointerdown", resume); window.addEventListener("keydown", resume); }
    } catch { this.ctx = null; }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }

  // ---- synth primitives -------------------------------------------------------------------------
  private env(gain: number, decay: number): GainNode {
    const g = this.ctx!.createGain(), t = this.ctx!.currentTime;
    g.gain.setValueAtTime(Math.max(0.0001, gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    return g;
  }

  private noiseSrc(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noiseBuf; s.loop = true;
    s.playbackRate.value = 0.9 + Math.random() * 0.2; // slight per-shot variation
    return s;
  }

  /** A filtered noise burst — the crack/thud/shatter body of most effects. */
  private burst(freq: number, type: BiquadFilterType, q: number, gain: number, decay: number, dest: AudioNode): void {
    const s = this.noiseSrc(), f = this.ctx!.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.env(gain, decay);
    s.connect(f); f.connect(g); g.connect(dest);
    const t = this.ctx!.currentTime; s.start(t); s.stop(t + decay + 0.03);
  }

  /** A short tone (body thump / ring / sub-boom), optionally sweeping pitch. */
  private tone(freq: number, type: OscillatorType, gain: number, decay: number, dest: AudioNode, sweepTo?: number): void {
    const o = this.ctx!.createOscillator(), t = this.ctx!.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (sweepTo !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + decay);
    const g = this.env(gain, decay);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + decay + 0.03);
  }

  /** Destination node for a spatial event `dist` metres away (attenuated); the master bus if local. */
  private dest(dist: number): AudioNode {
    if (dist <= 0) return this.master!;
    const g = this.ctx!.createGain(); g.gain.value = distanceGain(dist); g.connect(this.master!);
    return g;
  }

  // ---- effects ----------------------------------------------------------------------------------
  shot(weapon: string, dist = 0): void {
    if (!this.ctx) return;
    const p = WEAPON_SFX[weapon] ?? WEAPON_SFX.mg, d = this.dest(dist);
    this.burst(p.crackFreq, "bandpass", 1.2, p.gain, p.decay, d);
    this.tone(p.bodyFreq, "sine", p.gain * 0.8, p.decay * 1.5, d, p.bodyFreq * 0.5);
  }

  explosion(power: number, dist = 0): void {
    if (!this.ctx) return;
    const p = explosionParams(power), d = this.dest(dist);
    this.burst(220, "lowpass", 0.7, p.gain, p.decay, d);              // rumble
    this.tone(p.subFreq, "sine", p.gain, p.decay, d, p.subFreq * 0.4); // sub-boom
    this.burst(3200, "highpass", 0.7, p.gain * 0.4, 0.09, d);         // crack transient
  }

  impact(material: string, dist = 0): void {
    if (!this.ctx) return;
    const p = IMPACT_SFX[MAT_MAP[material] ?? "concrete"], d = this.dest(dist);
    this.burst(p.freq, p.filter, p.ring ? 6 : 1, p.gain, p.decay, d);
    if (p.ring) this.tone(p.freq, "sine", p.gain * 0.45, p.decay, d);
  }

  voxelBreak(dist = 0): void { if (this.ctx) this.burst(700, "bandpass", 0.8, 0.32, 0.13, this.dest(dist)); }
  hit(): void { if (!this.ctx) return; this.burst(420, "lowpass", 1, 0.5, 0.12, this.master!); this.tone(190, "sawtooth", 0.3, 0.16, this.master!, 90); }
  death(): void { if (this.ctx) this.tone(300, "sawtooth", 0.5, 0.7, this.master!, 55); }
  respawn(): void { if (this.ctx) this.tone(280, "sine", 0.4, 0.4, this.master!, 720); }
  weaponSwitch(): void { if (this.ctx) this.burst(2600, "highpass", 1, 0.25, 0.05, this.master!); }
  emptyClick(): void { if (this.ctx) this.burst(4200, "highpass", 2, 0.3, 0.03, this.master!); }
  place(): void { if (this.ctx) this.tone(620, "square", 0.2, 0.06, this.master!); }
  erase(): void { if (this.ctx) this.burst(1500, "bandpass", 1, 0.24, 0.06, this.master!); }
  footstep(run = false): void { if (this.ctx) this.burst(run ? 720 : 480, "lowpass", 0.9, run ? 0.3 : 0.2, run ? 0.08 : 0.06, this.master!); }
  jump(): void { if (this.ctx) this.tone(320, "sine", 0.25, 0.12, this.master!, 500); }
  land(): void { if (this.ctx) this.burst(300, "lowpass", 0.9, 0.42, 0.1, this.master!); }
  ui(): void { if (this.ctx) this.tone(880, "sine", 0.22, 0.08, this.master!, 1180); }
  melee(): void { if (this.ctx) this.burst(1600, "bandpass", 0.8, 0.4, 0.14, this.master!); }  // swing whoosh
  meleeHit(): void { if (!this.ctx) return; this.burst(480, "lowpass", 1, 0.55, 0.1, this.master!); this.tone(140, "square", 0.35, 0.12, this.master!, 80); } // butt-strike thud
  lowBattery(): void { if (this.ctx) this.tone(1200, "square", 0.18, 0.12, this.master!, 800); }

  /** Continuous drone rotor whose level (0..1) + speed set its loudness and pitch. Started lazily. */
  setRotor(level: number, speed: number): void {
    if (!this.ctx) return;
    if (!this.rotorGain) {
      if (level <= 0) return; // don't build the rotor graph until a drone actually needs it (human-only matches)
      const s = this.noiseSrc(), f = this.ctx.createBiquadFilter(), o = this.ctx.createOscillator(), g = this.ctx.createGain();
      f.type = "bandpass"; f.frequency.value = 180; f.Q.value = 4; o.type = "sawtooth"; o.frequency.value = 80; g.gain.value = 0;
      s.connect(f); f.connect(g); o.connect(g); g.connect(this.master!);
      s.start(); o.start();
      this.rotorGain = g; this.rotorFilter = f; this.rotorOsc = o;
    }
    const t = this.ctx.currentTime;
    this.rotorGain.gain.setTargetAtTime(Math.max(0, Math.min(0.11, level * 0.11)), t, 0.08);
    this.rotorFilter!.frequency.setTargetAtTime(150 + speed * 9, t, 0.1);
    this.rotorOsc!.frequency.setTargetAtTime(68 + speed * 3.5, t, 0.1);
  }
}
