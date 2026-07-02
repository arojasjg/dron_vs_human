// MLS-MPM grid update: fixed-point momentum/mass -> velocity, gravity, box walls.
// Transcription of gridUpdate() in cpu/mpm.ts. The fixed-point scale cancels in
// the momentum/mass division.
struct MG {
  dx: f32, invDx: f32, ox: f32, oy: f32, oz: f32,
  dimX: f32, dimY: f32, dimZ: f32,
  dt: f32, gravity: f32, mass: f32, vol: f32, E: f32, scale: f32, n: f32, pad: f32,
};

@group(0) @binding(0) var<storage, read_write> gridMassI: array<atomic<i32>>;
@group(0) @binding(1) var<storage, read_write> gridVelI: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read_write> gridVelF: array<f32>;
@group(0) @binding(3) var<uniform> G: MG;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let node = gid.x;
  let dimX = u32(G.dimX); let dimY = u32(G.dimY); let dimZ = u32(G.dimZ);
  if (node >= dimX * dimY * dimZ) { return; }

  let mi = atomicLoad(&gridMassI[node]);
  if (mi <= 0) {
    gridVelF[node * 3u + 0u] = 0.0; gridVelF[node * 3u + 1u] = 0.0; gridVelF[node * 3u + 2u] = 0.0;
    return;
  }
  let mf = f32(mi);
  var vx = f32(atomicLoad(&gridVelI[node * 3u + 0u])) / mf;
  var vy = f32(atomicLoad(&gridVelI[node * 3u + 1u])) / mf + G.dt * G.gravity;
  var vz = f32(atomicLoad(&gridVelI[node * 3u + 2u])) / mf;

  let x = i32(node % dimX);
  let y = i32((node / dimX) % dimY);
  let z = i32(node / (dimX * dimY));
  let dx = i32(dimX); let dy = i32(dimY); let dz = i32(dimZ);
  if (x < 2 && vx < 0.0) { vx = 0.0; } if (x > dx - 3 && vx > 0.0) { vx = 0.0; }
  if (y < 2 && vy < 0.0) { vy = 0.0; } if (y > dy - 3 && vy > 0.0) { vy = 0.0; }
  if (z < 2 && vz < 0.0) { vz = 0.0; } if (z > dz - 3 && vz > 0.0) { vz = 0.0; }

  gridVelF[node * 3u + 0u] = vx;
  gridVelF[node * 3u + 1u] = vy;
  gridVelF[node * 3u + 2u] = vz;
}
