// MLS-MPM grid -> particles gather (APIC), advect, update volume ratio.
// Transcription of g2p() in cpu/mpm.ts.
struct MG {
  dx: f32, invDx: f32, ox: f32, oy: f32, oz: f32,
  dimX: f32, dimY: f32, dimZ: f32,
  dt: f32, gravity: f32, mass: f32, vol: f32, E: f32, scale: f32, n: f32, pad: f32,
};

@group(0) @binding(0) var<storage, read_write> pos: array<f32>;
@group(0) @binding(1) var<storage, read_write> vel: array<f32>;
@group(0) @binding(2) var<storage, read_write> Cm: array<f32>;
@group(0) @binding(3) var<storage, read_write> Jp: array<f32>;
@group(0) @binding(4) var<storage, read> gridVelF: array<f32>;
@group(0) @binding(5) var<uniform> G: MG;

fn wq(f: f32) -> array<f32, 3> {
  return array<f32, 3>(0.5 * (1.5 - f) * (1.5 - f), 0.75 - (f - 1.0) * (f - 1.0), 0.5 * (f - 0.5) * (f - 0.5));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let p = gid.x;
  if (p >= u32(G.n)) { return; }
  let b = p * 3u;

  let gp = vec3<f32>((pos[b] - G.ox) * G.invDx, (pos[b + 1u] - G.oy) * G.invDx, (pos[b + 2u] - G.oz) * G.invDx);
  let base = vec3<i32>(i32(floor(gp.x - 0.5)), i32(floor(gp.y - 0.5)), i32(floor(gp.z - 0.5)));
  let fx = gp - vec3<f32>(base);
  let wx = wq(fx.x); let wy = wq(fx.y); let wz = wq(fx.z);

  let dimX = i32(G.dimX); let dimY = i32(G.dimY); let dimZ = i32(G.dimZ);
  var nv = vec3<f32>(0.0, 0.0, 0.0);
  var c: array<f32, 9>;
  for (var q = 0; q < 9; q = q + 1) { c[q] = 0.0; }

  for (var i = 0; i < 3; i = i + 1) {
    let nx = base.x + i; if (nx < 0 || nx >= dimX) { continue; }
    for (var j = 0; j < 3; j = j + 1) {
      let ny = base.y + j; if (ny < 0 || ny >= dimY) { continue; }
      for (var k = 0; k < 3; k = k + 1) {
        let nz = base.z + k; if (nz < 0 || nz >= dimZ) { continue; }
        let weight = wx[i] * wy[j] * wz[k];
        let node = u32((nz * dimY + ny) * dimX + nx);
        let gv = vec3<f32>(gridVelF[node * 3u + 0u], gridVelF[node * 3u + 1u], gridVelF[node * 3u + 2u]);
        nv = nv + weight * gv;
        let dpx = f32(i) - fx.x; let dpy = f32(j) - fx.y; let dpz = f32(k) - fx.z;
        let f = 4.0 * G.invDx * weight;
        c[0] = c[0] + f * gv.x * dpx; c[1] = c[1] + f * gv.x * dpy; c[2] = c[2] + f * gv.x * dpz;
        c[3] = c[3] + f * gv.y * dpx; c[4] = c[4] + f * gv.y * dpy; c[5] = c[5] + f * gv.y * dpz;
        c[6] = c[6] + f * gv.z * dpx; c[7] = c[7] + f * gv.z * dpy; c[8] = c[8] + f * gv.z * dpz;
      }
    }
  }

  vel[b] = nv.x; vel[b + 1u] = nv.y; vel[b + 2u] = nv.z;
  let cc = p * 9u;
  for (var q = 0u; q < 9u; q = q + 1u) { Cm[cc + q] = c[q]; }
  pos[b] = pos[b] + G.dt * nv.x;
  pos[b + 1u] = pos[b + 1u] + G.dt * nv.y;
  pos[b + 2u] = pos[b + 2u] + G.dt * nv.z;
  Jp[p] = Jp[p] * (1.0 + G.dt * (c[0] + c[4] + c[8]));
}
