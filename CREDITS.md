# Credits — third-party assets

## 3D models

- **Soldier** (`public/models/Soldier.glb`) — animated rigged soldier character (Idle / Walk / Run).
  Author: **kupvom**. Source: the [three.js](https://github.com/mrdoob/three.js) example assets
  (`examples/models/gltf/Soldier.glb`). License: **CC-BY 4.0** — attribution required (this file).

- **RobotExpressive** (`public/models/RobotExpressive.glb`) — animated rigged robot (alternate avatar).
  Author: **Tomás Laulhé**, modifications by Don McCurdy. Source: three.js example assets. License: **CC0**
  (public domain, no attribution required).

Both are loaded at runtime via `src/engine/modelLoader.ts` (GLTFLoader + AnimationMixer) and used as the
peer human avatar in `src/net/remoteDrones.ts`. To swap in your own character, drop a rigged glТF/GLB with
`Idle` / `Walk` / `Run` clips into `public/models/` and point `HUMAN_MODEL` at it.

## Sound effects

- Combat / world SFX in `public/sfx/*.mp3` were generated with the **ElevenLabs Sound Effects** API.
  Commercial use is governed by your ElevenLabs plan/terms.
