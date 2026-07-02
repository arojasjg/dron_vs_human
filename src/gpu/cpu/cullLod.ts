// GPU-driven rendering core: per-instance frustum culling + LOD selection +
// stream compaction. The compute kernel writes the visible instances and the count
// that feeds an indirect draw. CPU reference twin of cullLod.wgsl.

export interface CullParams {
  /** 6 frustum planes, packed as 6 * vec4(nx, ny, nz, d); visible if dot(n,p)+d+radius >= 0. */
  planes: Float32Array;
  cam: [number, number, number];
  /** distance thresholds: < lodNear -> LOD 0, < lodFar -> LOD 1, else LOD 2. */
  lodNear: number;
  lodFar: number;
  radius: number;
}

export interface CullResult {
  count: number;
  indices: Uint32Array; // visible particle indices, length = count
  lods: Uint32Array;    // LOD per visible instance, length = count
}

export function cullLod(positions: Float32Array, n: number, p: CullParams): CullResult {
  const indices = new Uint32Array(n);
  const lods = new Uint32Array(n);
  let count = 0;

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    let visible = true;
    for (let k = 0; k < 6; k++) {
      const px = p.planes[k * 4], py = p.planes[k * 4 + 1], pz = p.planes[k * 4 + 2], pd = p.planes[k * 4 + 3];
      if (px * x + py * y + pz * z + pd + p.radius < 0) { visible = false; break; }
    }
    if (!visible) continue;

    const dx = x - p.cam[0], dy = y - p.cam[1], dz = z - p.cam[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const lod = dist < p.lodNear ? 0 : dist < p.lodFar ? 1 : 2;
    indices[count] = i;
    lods[count] = lod;
    count++;
  }
  return { count, indices: indices.slice(0, count), lods: lods.slice(0, count) };
}
