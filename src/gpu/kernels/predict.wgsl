// PBD predict step: apply gravity to velocity and advance to a predicted position.
struct Params { dt: f32, gravity: f32, n: f32, pad: f32 };

@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> vel: array<f32>;
@group(0) @binding(2) var<storage, read_write> predicted: array<f32>;
@group(0) @binding(3) var<uniform> P: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(P.n)) { return; }
  let b = i * 3u;
  predicted[b] = pos[b] + vel[b] * P.dt;
  predicted[b + 1u] = pos[b + 1u] + (vel[b + 1u] + P.gravity * P.dt) * P.dt;
  predicted[b + 2u] = pos[b + 2u] + vel[b + 2u] * P.dt;
}
