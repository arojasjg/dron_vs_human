// GPU spatial-hash histogram — cell index (matches neighborGrid.ts) + atomic counts.
// This is the first stage of the counting-sort broadphase.
struct Grid {
  cellSize: f32,
  ox: f32, oy: f32, oz: f32,
  dx: f32, dy: f32, dz: f32,
  n: f32,
};

@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> G: Grid;

fn clampi(v: i32, dim: i32) -> i32 {
  if (v < 0) { return 0; }
  if (v >= dim) { return dim - 1; }
  return v;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(G.n)) { return; }
  let b = i * 3u;
  let dimX = i32(G.dx);
  let dimY = i32(G.dy);
  let dimZ = i32(G.dz);
  let cx = clampi(i32(floor((pos[b] - G.ox) / G.cellSize)), dimX);
  let cy = clampi(i32(floor((pos[b + 1u] - G.oy) / G.cellSize)), dimY);
  let cz = clampi(i32(floor((pos[b + 2u] - G.oz) / G.cellSize)), dimZ);
  let cell = (cz * dimY + cy) * dimX + cx;
  atomicAdd(&counts[cell], 1u);
}
