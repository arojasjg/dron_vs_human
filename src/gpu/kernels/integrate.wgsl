// GPU integrate kernel — transcription of src/gpu/cpu/integrate.ts.
// Params packed as f32 (n stored as f32, converted to u32) to avoid mixed-type uniforms.
struct Params {
  dt: f32,
  gravity: f32,
  damping: f32,
  wc: f32,
  wx: f32,
  wy: f32,
  wz: f32,
  n: f32,
};

@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> vel: array<f32>;
@group(0) @binding(2) var<uniform> P: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(P.n)) { return; }
  let b = i * 3u;

  var vx = vel[b];
  var vy = vel[b + 1u];
  var vz = vel[b + 2u];

  vy = vy + P.gravity * P.dt;
  vx = vx + (P.wx - vx) * P.wc * P.dt;
  vy = vy + (P.wy - vy) * P.wc * P.dt;
  vz = vz + (P.wz - vz) * P.wc * P.dt;

  let damp = 1.0 - P.damping;
  vx = vx * damp;
  vy = vy * damp;
  vz = vz * damp;

  vel[b] = vx;
  vel[b + 1u] = vy;
  vel[b + 2u] = vz;

  pos[b] = pos[b] + vx * P.dt;
  pos[b + 1u] = pos[b + 1u] + vy * P.dt;
  pos[b + 2u] = pos[b + 2u] + vz * P.dt;
}
