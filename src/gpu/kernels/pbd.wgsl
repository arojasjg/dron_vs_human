// PBD contact solve (one Jacobi iteration) over the fixed-capacity grid.
// Twin of one iteration of src/gpu/cpu/pbdSolve.ts. Reads posIn, writes posOut.
struct Params {
  cellSize: f32,
  ox: f32, oy: f32, oz: f32,
  dx: f32, dy: f32, dz: f32,
  n: f32,
  maxPerCell: f32,
  radius: f32,
  groundY: f32,
  stiffness: f32,
};

@group(0) @binding(0) var<storage, read> posIn: array<f32>;
@group(0) @binding(1) var<storage, read> cellCount: array<u32>;
@group(0) @binding(2) var<storage, read> cellPos: array<f32>; // neighbour positions, 3/slot
@group(0) @binding(3) var<storage, read_write> posOut: array<f32>;
@group(0) @binding(4) var<uniform> P: Params;

fn clampi(v: i32, dim: i32) -> i32 {
  if (v < 0) { return 0; }
  if (v >= dim) { return dim - 1; }
  return v;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(P.n)) { return; }
  let b = i * 3u;
  let xi = vec3<f32>(posIn[b], posIn[b + 1u], posIn[b + 2u]);

  let dimX = i32(P.dx);
  let dimY = i32(P.dy);
  let dimZ = i32(P.dz);
  let cap = u32(P.maxPerCell);
  let cx = clampi(i32(floor((xi.x - P.ox) / P.cellSize)), dimX);
  let cy = clampi(i32(floor((xi.y - P.oy) / P.cellSize)), dimY);
  let cz = clampi(i32(floor((xi.z - P.oz) / P.cellSize)), dimZ);

  let d0 = 2.0 * P.radius;
  let d02 = d0 * d0;
  var corr = vec3<f32>(0.0, 0.0, 0.0);
  var cnt = 0u;

  for (var oz = -1; oz <= 1; oz = oz + 1) {
    let z = cz + oz;
    if (z < 0 || z >= dimZ) { continue; }
    for (var oy = -1; oy <= 1; oy = oy + 1) {
      let y = cy + oy;
      if (y < 0 || y >= dimY) { continue; }
      for (var ox = -1; ox <= 1; ox = ox + 1) {
        let x = cx + ox;
        if (x < 0 || x >= dimX) { continue; }
        let cell = u32((z * dimY + y) * dimX + x);
        let count = min(cellCount[cell], cap);
        for (var s = 0u; s < count; s = s + 1u) {
          let o = (cell * cap + s) * 3u;
          let a = xi - vec3<f32>(cellPos[o], cellPos[o + 1u], cellPos[o + 2u]);
          let dist2 = dot(a, a);
          // dist2 < eps is self (its own position is stored in the cell)
          if (dist2 >= d02 || dist2 < 1e-12) { continue; }
          let dist = sqrt(dist2);
          let half = (d0 - dist) * 0.5 * P.stiffness / dist;
          corr = corr + a * half;
          cnt = cnt + 1u;
        }
      }
    }
  }

  var p = xi;
  if (cnt > 0u) { p = xi + corr / f32(cnt); }
  let minY = P.groundY + P.radius;
  if (p.y < minY) { p.y = minY; }
  posOut[b] = p.x;
  posOut[b + 1u] = p.y;
  posOut[b + 2u] = p.z;
}
