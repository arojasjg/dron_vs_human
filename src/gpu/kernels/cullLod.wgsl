// GPU frustum culling + LOD + stream compaction. Visible instances are appended via
// an atomic counter (which becomes the indirect-draw instanceCount). Twin of cullLod.ts.
struct Params {
  camX: f32, camY: f32, camZ: f32,
  lodNear: f32, lodFar: f32, radius: f32, n: f32, pad: f32,
};

@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> planes: array<vec4<f32>, 6>;
@group(0) @binding(2) var<storage, read_write> counter: atomic<u32>;
@group(0) @binding(3) var<storage, read_write> outIndices: array<u32>;
@group(0) @binding(4) var<storage, read_write> outLods: array<u32>;
@group(0) @binding(5) var<uniform> P: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u32(P.n)) { return; }
  let b = i * 3u;
  let pp = vec3<f32>(pos[b], pos[b + 1u], pos[b + 2u]);

  for (var k = 0; k < 6; k = k + 1) {
    let pl = planes[k];
    if (dot(pl.xyz, pp) + pl.w + P.radius < 0.0) { return; }
  }

  let d = pp - vec3<f32>(P.camX, P.camY, P.camZ);
  let dist = length(d);
  var lod = 2u;
  if (dist < P.lodNear) { lod = 0u; } else if (dist < P.lodFar) { lod = 1u; }

  let slot = atomicAdd(&counter, 1u);
  outIndices[slot] = i;
  outLods[slot] = lod;
}
