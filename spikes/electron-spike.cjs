// Feasibility spike: does Electron's Chromium expose a WebGPU adapter here, and with which switches?
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

for (const sw of (process.env.SPIKE_SWITCHES || '').split(';').filter(Boolean)) {
  const [k, v] = sw.split('=', 2);
  app.commandLine.appendSwitch(k, v);
}

const probe = `(async () => {
  const out = { hasGpu: !!navigator.gpu };
  try {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    out.adapter = !!a;
    if (a) {
      out.info = { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description };
      out.features = [...a.features].sort();
      out.limits = { tex: a.limits.maxTextureDimension2D, buf: a.limits.maxBufferSize, sbb: a.limits.maxStorageBufferBindingSize, stps: a.limits.maxStorageTexturesPerShaderStage };
      const d = await a.requestDevice({ requiredFeatures: out.features.filter(f => ['float32-filterable','texture-formats-tier1','texture-formats-tier2','timestamp-query'].includes(f)) });
      const t = d.createTexture({ size: [256, 256], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
      const m = d.createShaderModule({ code: '@group(0) @binding(0) var h: texture_storage_2d<r32float, read_write>; @compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id: vec3u){ textureStore(h, id.xy, vec4f(f32(id.x) * 0.5 + textureLoad(h, id.xy).r)); }' });
      const p = await d.createComputePipelineAsync({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
      const e = d.createCommandEncoder(); const c = e.beginComputePass(); c.setPipeline(p);
      c.setBindGroup(0, d.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.createView() }] }));
      c.dispatchWorkgroups(32, 32); c.end();
      const b = d.createBuffer({ size: 256 * 4 * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      e.copyTextureToBuffer({ texture: t }, { buffer: b, bytesPerRow: 1024 }, [256, 256]);
      d.queue.submit([e.finish()]); await b.mapAsync(GPUMapMode.READ);
      out.computeSample = new Float32Array(b.getMappedRange())[255];
      const cv = document.createElement('canvas'); const ctx = cv.getContext('webgpu');
      out.canvasCtx = !!ctx; out.preferredFormat = navigator.gpu.getPreferredCanvasFormat();
    }
  } catch (e) { out.err = String(e); }
  return out;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadFile(path.join(__dirname, 'blank.html'));
  const res = await win.webContents.executeJavaScript(probe);
  console.log('SPIKE_RESULT ' + JSON.stringify(res));
  app.quit();
});
setTimeout(() => { console.log('SPIKE_RESULT {"timeout":true}'); app.exit(1); }, 30000);
