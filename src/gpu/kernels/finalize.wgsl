// PBD finalize: derive velocity from the position change, commit the new position.
struct Params { dt: f32, damping: f32, n: f32, pad: f32 };

@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> vel: array<f32>;
@group(0) @binding(2) var<storage, read> finalPos: array<f32>;
@group(0) @binding(3) var<uniform> P: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(P.n)) { return; }
  let b = i * 3u;
  let inv = 1.0 / P.dt;
  let damp = 1.0 - P.damping;
  vel[b] = (finalPos[b] - pos[b]) * inv * damp;
  vel[b + 1u] = (finalPos[b + 1u] - pos[b + 1u]) * inv * damp;
  vel[b + 2u] = (finalPos[b + 2u] - pos[b + 2u]) * inv * damp;
  pos[b] = finalPos[b];
  pos[b + 1u] = finalPos[b + 1u];
  pos[b + 2u] = finalPos[b + 2u];
}
