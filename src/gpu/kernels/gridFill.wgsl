// Fixed-capacity grid fill — atomic insertion. Twin of src/gpu/cpu/fixedGrid.ts.
// cellCount must be zero-cleared before dispatch.
struct Grid {
  cellSize: f32,
  ox: f32, oy: f32, oz: f32,
  dx: f32, dy: f32, dz: f32,
  n: f32,
  maxPerCell: f32,
  pad0: f32, pad1: f32, pad2: f32, // pad struct to 48 bytes (16-byte aligned)
};

@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> cellCount: array<atomic<u32>>;
// store neighbour POSITIONS (3 floats) per slot, not indices — contiguous reads in
// the PBD solve avoid the scattered posIn[j] gather (memory coherence optimization).
@group(0) @binding(2) var<storage, read_write> cellPos: array<f32>;
@group(0) @binding(3) var<uniform> G: Grid;

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
  let cell = u32((cz * dimY + cy) * dimX + cx);
  let slot = atomicAdd(&cellCount[cell], 1u);
  let cap = u32(G.maxPerCell);
  if (slot < cap) {
    let o = (cell * cap + slot) * 3u;
    cellPos[o] = pos[b];
    cellPos[o + 1u] = pos[b + 1u];
    cellPos[o + 2u] = pos[b + 2u];
  }
}
