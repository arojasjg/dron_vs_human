export type MaterialId =
  | "wood" | "concrete" | "brick" | "glass" | "metal" | "gastank"
  | "wall_slate" | "wall_moss" | "wall_clay" | "wall_navy";

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
  glass: {
    id: "glass", name: "Vidrio", color: 0x9fd6e6, roughness: 0.05, metalness: 0.0,
    density: 2500, strength: 10, hp: 1, restitution: 0.1, friction: 0.4, opacity: 0.35, shatters: true,
  },
  metal: {
    id: "metal", name: "Metal", color: 0x8a909a, roughness: 0.3, metalness: 0.9,
    density: 7800, strength: 320, hp: 5, restitution: 0.2, friction: 0.6, opacity: 1, shatters: false,
  },
  // explosive: a gas tank. A single bullet sets it off and it detonates in a chain.
  gastank: {
    id: "gastank", name: "Tambo de gas", color: 0xd4471f, roughness: 0.4, metalness: 0.7,
    density: 1200, strength: 28, hp: 1, restitution: 0.2, friction: 0.6, opacity: 1, shatters: false,
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
};

export const MATERIAL_ORDER: MaterialId[] = [
  "wood", "concrete", "brick", "glass", "metal", "gastank",
  "wall_slate", "wall_moss", "wall_clay", "wall_navy",
];
