// MLS-MPM particles -> grid scatter. Float accumulation via fixed-point integer
// atomics (WGSL atomics are integer-only). Transcription of p2g() in cpu/mpm.ts.
struct MG {
  dx: f32, invDx: f32, ox: f32, oy: f32, oz: f32,
  dimX: f32, dimY: f32, dimZ: f32,
  dt: f32, gravity: f32, mass: f32, vol: f32, E: f32, scale: f32, n: f32, pad: f32,
};

@group(0) @binding(0) var<storage, read> pos: array<f32>;
@group(0) @binding(1) var<storage, read> vel: array<f32>;
@group(0) @binding(2) var<storage, read> Cm: array<f32>;   // n*9 affine
@group(0) @binding(3) var<storage, read> Jp: array<f32>;   // n
@group(0) @binding(4) var<storage, read_write> gridMassI: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read_write> gridVelI: array<atomic<i32>>; // nodes*3
@group(0) @binding(6) var<uniform> G: MG;

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

  let stress = -G.dt * G.vol * (Jp[p] - 1.0) * 4.0 * G.invDx * G.invDx * G.E;
  let m = G.mass;
  let c = p * 9u;
  let a00 = stress + m * Cm[c + 0u]; let a01 = m * Cm[c + 1u]; let a02 = m * Cm[c + 2u];
  let a10 = m * Cm[c + 3u]; let a11 = stress + m * Cm[c + 4u]; let a12 = m * Cm[c + 5u];
  let a20 = m * Cm[c + 6u]; let a21 = m * Cm[c + 7u]; let a22 = stress + m * Cm[c + 8u];
  let v = vec3<f32>(vel[b], vel[b + 1u], vel[b + 2u]);

  let dimX = i32(G.dimX); let dimY = i32(G.dimY); let dimZ = i32(G.dimZ);
  for (var i = 0; i < 3; i = i + 1) {
    let nx = base.x + i; if (nx < 0 || nx >= dimX) { continue; }
    for (var j = 0; j < 3; j = j + 1) {
      let ny = base.y + j; if (ny < 0 || ny >= dimY) { continue; }
      for (var k = 0; k < 3; k = k + 1) {
        let nz = base.z + k; if (nz < 0 || nz >= dimZ) { continue; }
        let weight = wx[i] * wy[j] * wz[k];
        let dpx = (f32(i) - fx.x) * G.dx; let dpy = (f32(j) - fx.y) * G.dx; let dpz = (f32(k) - fx.z) * G.dx;
        let avx = a00 * dpx + a01 * dpy + a02 * dpz;
        let avy = a10 * dpx + a11 * dpy + a12 * dpz;
        let avz = a20 * dpx + a21 * dpy + a22 * dpz;
        let node = u32((nz * dimY + ny) * dimX + nx);
        atomicAdd(&gridMassI[node], i32(round(weight * m * G.scale)));
        atomicAdd(&gridVelI[node * 3u + 0u], i32(round(weight * (m * v.x + avx) * G.scale)));
        atomicAdd(&gridVelI[node * 3u + 1u], i32(round(weight * (m * v.y + avy) * G.scale)));
        atomicAdd(&gridVelI[node * 3u + 2u], i32(round(weight * (m * v.z + avz) * G.scale)));
      }
    }
  }
}
