# Particles — Constructor & Destrucción física

Sandbox web donde construyes casas, muros, torres, vehículos u objetos con vóxeles
de distintos materiales y los destruyes con física realista: abres **hoyos exactamente
donde impactas**, todo se rompe en **muchísimas partes** que caen, chocan y son
arrastradas por el **viento**, con **luz**, **sombras** y **reflejos** PBR.

Construido con **Three.js** (render) + **Rapier3D** (física, Rust→WASM) + **Vite** + **TypeScript**.

## Cómo correr

```bash
npm install
npm run dev      # abre http://localhost:5173
```

Otros comandos:

```bash
npm run build    # type-check + bundle de producción
npm run test     # tests (lógica de vóxeles, integridad, materiales, destrucción)
npm run smoke    # smoke test headless en Edge (renderiza y detona la escena)
```

## Controles

- **Clic** en la pantalla captura el ratón · **Esc** lo suelta.
- **WASD** moverse · **Espacio/Ctrl** subir/bajar · **Shift** turbo.
- **Clic izq** usar herramienta · **Clic der** disparo rápido (perfora).
- **Rueda** tamaño de brocha al construir.
- **1** Disparar · **2** Granada · **3** Bola de cañón · **4** Construir · **5** Borrar.
- **Q/E** cambiar material (madera, concreto, ladrillo, vidrio, metal).
- **G** casa · **B** muro · **T** torre · **V** auto · **R** escena inicial · **C** vaciar.
- **P** guardar · **L** cargar · **F** lanzar caja · **H** ocultar ayuda.

## Cómo funciona

- **Mundo en vóxeles** (`src/world`): rejilla dispersa renderizada con `InstancedMesh`
  por material; el cuerpo de colisión estático se reconstruye por *greedy meshing*
  (cajas fusionadas) en cada edición/destrucción.
- **Destrucción** (`src/destruction`): `carveSphere` quita vóxeles sólo donde la
  energía de impacto (con caída por distancia) supera la **resistencia del material**
  — el metal aguanta, el vidrio se hace añicos. Los vóxeles retirados se convierten en
  cuerpos rígidos reales (o polvo cuando se agota el presupuesto del evento).
- **Integridad estructural** (`structuralIntegrity.ts`): tras cada destrucción, un
  *flood-fill* desde el suelo detecta las partes sin soporte y las hace caer.
- **Aire** (`physics.ts`): viento con ráfagas + arrastre aerodinámico por cuerpo,
  aplicado como impulso cada paso, así el polvo y los escombros ligeros derivan.
- **Materiales** (`materials.ts`): densidad (→ masa real), resistencia, fricción,
  restitución y opacidad por material.

## Rendimiento y escala (hacia millones de partículas)

El motor usa una **arquitectura de dos capas** para escalar sin perder física realista:

1. **Capa GPU — millones de partículas** (`fx/gpuParticles.ts`). Polvo, humo, chispas y
   debris fino se simulan 100% en la GPU con **GPGPU sobre texturas float**
   (`GPUComputationRenderer`, WebGL2): posición y velocidad viven en texturas, se integran
   en shaders (gravedad/flotabilidad, viento, vida) y nunca vuelven a la CPU. Emisores en
   *ring buffer* que se "arman" al emitir y se "desarman" tras cada `compute()`. Por defecto
   **1024² = ~1.05M partículas**; configurable con `?ptex=N` (p. ej. `?ptex=1448` ≈ 2M).
   Si la GPU no soporta texturas float, cae automáticamente al sistema de partículas CPU.
2. **Capa CPU — física rígida exacta** (Rapier): los pedazos que importan (losas, cajas,
   proyectiles) son cuerpos rígidos reales que colisionan entre sí y con la estructura.
   Esta capa se mantiene en **cientos–miles** de cuerpos a propósito (es el límite práctico
   de la física de contactos en navegador hoy).

**Las partículas GPU son objetos físicos**, no sprites: colisionan con el mundo vía un
*height field* (`fx/heightField.ts`) que mapea la superficie superior del mundo y se muestrea
en los shaders de simulación → reposan sobre techos, suelo y escombros. Verificado por
*readback*: 27k partículas soltadas sobre un muro caen desde y=6 y **reposan exactamente en el
techo (y=3.5), 0 atraviesan el suelo** (`scripts/verify-collision.mjs`). El costo CPU por frame
es **independiente del número de partículas**: 16× más partículas (65k→1.05M) cuesta **1.13×**
de CPU/frame (`scripts/verify-scaling.mjs`) — todo el trabajo por-partícula vive en la GPU.

Optimizaciones medidas que sostienen los FPS:

- **Colliders por chunks** (`voxelCollider.ts`): cada destrucción reconstruye solo el chunk
  tocado. Medido: **0.98 ms vs 7.23 ms** del rebuild completo (**7.4×**), e independiente del
  tamaño del mundo. Ver `tests/perf.test.ts`.
- **Escombros en losa rígida** (`chunkDebris.ts`): un derrumbe de 50 vóxeles = **1 cuerpo**,
  no 50 → mucho menos trabajo de física. Ver `tests/chunkDebris.test.ts`.
- **Gobernador de FPS adaptativo** (`perfGovernor.ts`): si los FPS caen, baja el presupuesto
  de escombros y lo restaura al recuperarse → FPS estables bajo destrucción intensa.
- **InstancedMesh** + color por instancia para el mundo estático; pool + *sleep-despawn* para
  los escombros; partículas con *frustumCulled* desactivado y `boundingSphere` infinita.

### Estado del arte (junio 2026) y roadmap a "millones de objetos"

- **Partículas: WebGPU compute + TSL** es el siguiente techo. Mueve la simulación a *compute
  shaders* (no fragment), permitiendo decenas de millones; three.js compila TSL a WGSL/GLSL y
  `WebGPURenderer` cae a WebGL2 si no hay WebGPU. Soporte de navegador amplio en 2026
  (Chrome/Edge/Firefox desktop; Safari 26 en macOS/iOS). Ejemplo real: 1M partículas a 60 fps
  (Expo 2025 Osaka).
- **Render de millones de objetos**: *indirect draw* + **culling y selección de LOD por
  compute** en GPU (`IndirectStorageBufferAttribute`), `BatchedMesh`/`InstancedMesh2` con BVH
  para culling por instancia y *array textures* para variedad con un solo draw call.
- **Física de millones de cuerpos rígidos**: aún **no resuelta** con contactos completos en
  navegador. Lo más avanzado en cuerpos rígidos exactos es física GPU experimental (solver
  **AVBD**, *webphysics*) que hoy maneja decenas de cuerpos. Pero el camino **probado** a
  millones de *objetos con física* es **DEM en GPU con spatial hashing** (binning en rejilla +
  colisión solo entre celdas vecinas, en compute shaders): en 2026 ya logra **1M partículas
  interactivas a 60 fps** y 50k+ objetos en colisión. Es la evolución directa de lo que ya
  hacemos (partículas GPU que ya colisionan con el mundo) → añadir colisión partícula-partícula.

### Ya implementado (esta iteración)

- ✅ **Repulsión partícula-partícula** (`fx/gpuParticles.ts`): un *splat* aditivo de las
  partículas a una rejilla de densidad XZ + empuje por gradiente de densidad → las partículas
  se apartan entre sí (pseudo-colisión). Verificado: un cúmulo de 21k pasa de **0.24 m a ~4 m
  de dispersión RMS** al activar la repulsión (`scripts/verify-repel.mjs`).
- ✅ **Render como cubos instanciados con LOD**: las partículas cercanas se dibujan como cubos
  3D sólidos sombreados (lejos: puntos), leyendo la textura de posición. Verificado por captura
  en escena solo-GPU (`scripts/verify-cubes.mjs`, `shot-cubes.png`).

### Próximos pasos concretos (en orden)

1. **DEM exacto con spatial hashing en GPU** (binning + sort) → colisión partícula-partícula
   *precisa* (la repulsión actual es una aproximación por campo de densidad). Es WebGPU-compute.
2. **Colisión volumétrica** (occupancy 3D) en vez de *height field* → piling dentro de cuartos
   y bajo voladizos.
3. **Migración a `WebGPURenderer` + TSL compute** → mueve la simulación a *compute shaders*
   reales (decenas de millones) y habilita el solver GPU; cae a WebGL2 si no hay WebGPU.
   `engine/capabilities.ts` ya detecta `navigator.gpu` en runtime.

Fuentes: [Three.js + WebGPU compute (TSL)](https://threejsroadmap.com/blog/introduction-to-webgpu-compute-shaders) ·
[Migrar a WebGPU 2026](https://www.utsubo.com/blog/webgpu-threejs-migration-guide) ·
[webphysics (AVBD GPU)](https://github.com/jure/webphysics) ·
[1M partículas GPGPU](https://github.com/poeti8/one-million-particles) ·
[GPUComputationRenderer](https://threejs.org/docs/pages/GPUComputationRenderer.html) ·
[DEM/spatial hashing en WebGPU (1M @60fps)](https://markaicode.com/webgpu-physics-simulation-1m-particles/) ·
[Rapier 2025/2026](https://dimforge.com/blog/2026/01/09/the-year-2025-in-dimforge/).

## Límites conocidos / próximos pasos

- **Millones de *partículas*: sí** (capa GPU). **Millones de *cuerpos rígidos con contactos*:
  todavía no** en navegador — es una limitación del estado del arte, no del diseño; ver roadmap.
- El smoke test headless usa render por software (SwiftShader) y corre a propósito con
  `?ptex=256`; los ~60 fps con 1M partículas son en GPU real.
- La fractura de los escombros es por vóxeles (no Voronoi real); los vehículos son
  destructibles pero no conducibles.
