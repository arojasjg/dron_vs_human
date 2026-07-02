// Radial explosion impulse — twin of src/gpu/cpu/impulse.ts.
struct Imp {
  cx: f32, cy: f32, cz: f32,
  radius: f32, strength: f32, n: f32,
  pad0: f32, pad1: f32,
};

@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> vel: array<f32>;
@group(0) @binding(2) var<uniform> I: Imp;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(I.n)) { return; }
  let b = i * 3u;
  let d = vec3<f32>(pos[b] - I.cx, pos[b + 1u] - I.cy, pos[b + 2u] - I.cz);
  let dist = length(d);
  if (dist >= I.radius) { return; }
  let f = (1.0 - dist / I.radius) * I.strength;
  let inv = select(0.0, 1.0 / dist, dist > 1e-6);
  vel[b] = vel[b] + d.x * inv * f;
  vel[b + 1u] = vel[b + 1u] + d.y * inv * f + f * 0.4;
  vel[b + 2u] = vel[b + 2u] + d.z * inv * f;
}
