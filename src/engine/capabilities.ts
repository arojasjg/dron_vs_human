export interface GpuCapabilities {
  webgpu: boolean;
  webgpuAdapter: boolean;
  adapterInfo: string;
}

/**
 * Detects WebGPU availability at runtime. WebGPU (compute shaders + TSL) is the path to
 * tens of millions of GPU-simulated objects; today the engine runs on WebGL2 GPGPU and
 * this report tells us whether the WebGPU tier can be enabled on this machine.
 */
export async function detectGpu(): Promise<GpuCapabilities> {
  const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } };
  const caps: GpuCapabilities = { webgpu: false, webgpuAdapter: false, adapterInfo: "n/a" };
  if (nav.gpu) {
    caps.webgpu = true;
    try {
      const adapter = (await nav.gpu.requestAdapter()) as
        | { info?: { vendor?: string; architecture?: string } }
        | null;
      caps.webgpuAdapter = !!adapter;
      if (adapter?.info) caps.adapterInfo = `${adapter.info.vendor ?? "?"} ${adapter.info.architecture ?? ""}`.trim();
    } catch {
      /* requestAdapter can throw on some setups; treat as no adapter */
    }
  }
  console.info(
    `[capabilities] WebGPU=${caps.webgpu} adapter=${caps.webgpuAdapter} (${caps.adapterInfo}); ` +
    `motor actual: WebGL2 GPGPU (~1M+ partículas). WebGPU compute = siguiente tier.`,
  );
  return caps;
}
