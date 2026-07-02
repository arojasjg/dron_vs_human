// Box container collision — clamp grains inside the domain and onto the floor.
// Twin of src/gpu/cpu/worldCollide.ts. In-place on positions.
struct Bounds {
  minX: f32, maxX: f32, minZ: f32, maxZ: f32,
  groundY: f32, radius: f32, n: f32, pad: f32,
};

@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<uniform> W: Bounds;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(W.n)) { return; }
  let b = i * 3u;
  let r = W.radius;
  pos[b] = clamp(pos[b], W.minX + r, W.maxX - r);
  pos[b + 1u] = max(pos[b + 1u], W.groundY + r);
  pos[b + 2u] = clamp(pos[b + 2u], W.minZ + r, W.maxZ - r);
}
