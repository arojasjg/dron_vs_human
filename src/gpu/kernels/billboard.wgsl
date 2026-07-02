// Instanced camera-facing billboard, shaded as a sphere. 6 verts/grain (vs 36 for a
// cube). Reads the instance position from the GPU sim's position buffer.
const R: f32 = 0.1; // grain radius

struct Cam { view: mat4x4<f32>, proj: mat4x4<f32> };
@group(0) @binding(0) var<uniform> cam: Cam;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) col: vec3<f32>,
  @location(1) uv: vec2<f32>,
};

@vertex
fn vs(@location(0) corner: vec2<f32>, @location(1) inst: vec3<f32>) -> VOut {
  var o: VOut;
  var vp = cam.view * vec4<f32>(inst, 1.0);
  vp.x = vp.x + corner.x * R;
  vp.y = vp.y + corner.y * R;
  o.clip = cam.proj * vp;
  o.uv = corner;
  let h = clamp(inst.y / 8.0, 0.0, 1.0);
  o.col = mix(vec3<f32>(0.45, 0.30, 0.18), vec3<f32>(0.86, 0.80, 0.66), h);
  return o;
}

@fragment
fn fs(o: VOut) -> @location(0) vec4<f32> {
  let r2 = dot(o.uv, o.uv);
  if (r2 > 1.0) { discard; }
  let n = vec3<f32>(o.uv, sqrt(1.0 - r2)); // view-space sphere normal
  let L = normalize(vec3<f32>(0.4, 0.55, 0.75));
  let lit = max(dot(n, L), 0.0) * 0.75 + 0.3;
  return vec4<f32>(o.col * lit, 1.0);
}
