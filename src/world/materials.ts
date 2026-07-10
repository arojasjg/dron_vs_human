export type MaterialId =
  | "wood" | "concrete" | "brick" | "glass" | "metal" | "gastank"
  | "wall_slate" | "wall_moss" | "wall_clay" | "wall_navy"
  | "car_red" | "car_blue" | "car_teal" | "tire" | "leaves" | "leaves_pine";

export interface MaterialDef {
  id: MaterialId;
  name: string;
  color: number;
  roughness: number;
  metalness: number;
  /** kg/m^3 — combined with voxel volume gives realistic mass. */
  density: number;
  /** Impact energy (J) needed to break a voxel of this material (explosions). */
  strength: number;
  /** Number of bullet hits needed to destroy one voxel of this material. */
  hp: number;
  restitution: number;
  friction: number;
  /** glass < 1 → translucent. */
  opacity: number;
  /** Pulverised voxels left as dust instead of debris when shattered. */
  shatters: boolean;
  /** Optional self-illumination (VISUAL ONLY — never touches physics). Lit windows, a hot gas-tank shell.
   *  Bright enough emissives also seed the ALTO-only bloom pass. Omit → no glow. */
  emissive?: number;
  emissiveIntensity?: number;
}

export const MATERIALS: Record<MaterialId, MaterialDef> = {
  wood: {
    id: "wood", name: "Madera", color: 0xa9743b, roughness: 0.85, metalness: 0.0,
    density: 550, strength: 35, hp: 2, restitution: 0.15, friction: 0.9, opacity: 1, shatters: false,
  },
  concrete: {
    id: "concrete", name: "Concreto", color: 0x9a9a93, roughness: 0.95, metalness: 0.0,
    density: 2400, strength: 130, hp: 4, restitution: 0.05, friction: 0.95, opacity: 1, shatters: false,
  },
  brick: {
    id: "brick", name: "Ladrillo", color: 0xa64b36, roughness: 0.9, metalness: 0.0,
    density: 1900, strength: 95, hp: 3, restitution: 0.08, friction: 0.9, opacity: 1, shatters: false,
  },
  // Windows carry a faint interior glow (emissive) so the skyline reads as inhabited even in shade — a big
  // "living city" cue at zero fill cost, and it survives the loss of IBL reflections on the pane.
  glass: {
    id: "glass", name: "Vidrio", color: 0x9fd6e6, roughness: 0.05, metalness: 0.0,
    density: 2500, strength: 10, hp: 1, restitution: 0.1, friction: 0.4, opacity: 0.35, shatters: true,
    emissive: 0x1c3a45, emissiveIntensity: 1.0,
  },
  // metalness dropped 0.9→0.6 + roughness 0.3→0.45: without IBL a near-pure metal has nothing to reflect
  // and reads almost black — a broader rough highlight from the direct sun keeps it looking like brushed steel.
  metal: {
    id: "metal", name: "Metal", color: 0x8a909a, roughness: 0.45, metalness: 0.6,
    density: 7800, strength: 320, hp: 5, restitution: 0.2, friction: 0.6, opacity: 1, shatters: false,
  },
  // explosive: a gas tank. A single bullet sets it off and it detonates in a chain. A hot emissive shell
  // reads it as "danger" at a glance (and blooms on ALTO); metalness eased for the no-IBL direct lighting.
  gastank: {
    id: "gastank", name: "Tambo de gas", color: 0xd4471f, roughness: 0.45, metalness: 0.45,
    density: 1200, strength: 28, hp: 1, restitution: 0.2, friction: 0.6, opacity: 1, shatters: false,
    emissive: 0x531004, emissiveIntensity: 1.3,
  },
  // Muted, sombre facade tints — physically identical to brick (so destruction is unchanged), only
  // the colour differs. buildDefaultScene picks one per building for a varied but grim skyline.
  wall_slate: {
    id: "wall_slate", name: "Pizarra", color: 0x474e56, roughness: 0.92, metalness: 0.0,
    density: 1900, strength: 95, hp: 3, restitution: 0.08, friction: 0.9, opacity: 1, shatters: false,
  },
  wall_moss: {
    id: "wall_moss", name: "Musgo", color: 0x4c5545, roughness: 0.92, metalness: 0.0,
    density: 1900, strength: 95, hp: 3, restitution: 0.08, friction: 0.9, opacity: 1, shatters: false,
  },
  wall_clay: {
    id: "wall_clay", name: "Arcilla", color: 0x6b4a3e, roughness: 0.92, metalness: 0.0,
    density: 1900, strength: 95, hp: 3, restitution: 0.08, friction: 0.9, opacity: 1, shatters: false,
  },
  wall_navy: {
    id: "wall_navy", name: "Marino", color: 0x3d4654, roughness: 0.92, metalness: 0.0,
    density: 1900, strength: 95, hp: 3, restitution: 0.08, friction: 0.9, opacity: 1, shatters: false,
  },
  // Glossy vehicle paint — physically like sheet metal (so destruction is unchanged), only the colour
  // + a car-paint sheen differ. A vehicle picks one per body (seeded) for a varied street.
  car_red: {
    id: "car_red", name: "Rojo", color: 0xb23a2e, roughness: 0.35, metalness: 0.45,
    density: 7800, strength: 320, hp: 5, restitution: 0.2, friction: 0.6, opacity: 1, shatters: false,
  },
  car_blue: {
    id: "car_blue", name: "Azul", color: 0x2f5b8a, roughness: 0.35, metalness: 0.45,
    density: 7800, strength: 320, hp: 5, restitution: 0.2, friction: 0.6, opacity: 1, shatters: false,
  },
  car_teal: {
    id: "car_teal", name: "Verde", color: 0x2f7f6e, roughness: 0.35, metalness: 0.45,
    density: 7800, strength: 320, hp: 5, restitution: 0.2, friction: 0.6, opacity: 1, shatters: false,
  },
  // Rubber tyre — dark, matte, tough.
  tire: {
    id: "tire", name: "Neumático", color: 0x18181c, roughness: 0.95, metalness: 0.0,
    density: 1100, strength: 90, hp: 4, restitution: 0.35, friction: 0.95, opacity: 1, shatters: false,
  },
  // Tree foliage — light, weak, shatters into leaf dust. A tree's canopy breaks off with almost any hit.
  leaves: {
    id: "leaves", name: "Follaje", color: 0x4a7a3a, roughness: 0.9, metalness: 0.0,
    density: 300, strength: 18, hp: 1, restitution: 0.0, friction: 0.8, opacity: 1, shatters: true,
  },
  // Conifer needles — a darker, cooler green for pines. Physically identical to leaves (so destruction is
  // unchanged), only the colour differs, for a varied treeline.
  leaves_pine: {
    id: "leaves_pine", name: "Pino", color: 0x2f5a2c, roughness: 0.92, metalness: 0.0,
    density: 300, strength: 18, hp: 1, restitution: 0.0, friction: 0.8, opacity: 1, shatters: true,
  },
};

export const MATERIAL_ORDER: MaterialId[] = [
  "wood", "concrete", "brick", "glass", "metal", "gastank",
  "wall_slate", "wall_moss", "wall_clay", "wall_navy",
  "car_red", "car_blue", "car_teal", "tire", "leaves", "leaves_pine",
];
