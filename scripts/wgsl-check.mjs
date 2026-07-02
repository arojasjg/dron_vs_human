import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDevice } from "./lib/gpuRun.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src/gpu/kernels");
const device = await getDevice();

let bad = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".wgsl"))) {
  const code = readFileSync(join(dir, f), "utf8");
  const mod = device.createShaderModule({ code });
  const info = await mod.getCompilationInfo();
  const errs = info.messages.filter((m) => m.type === "error");
  if (errs.length) {
    bad++;
    console.log(`✗ ${f}`);
    for (const m of errs) console.log(`   line ${m.lineNum}: ${m.message}`);
  } else {
    console.log(`✓ ${f}`);
  }
}
process.exit(bad ? 1 : 0);
