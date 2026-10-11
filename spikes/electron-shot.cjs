// Feasibility spike: can we screenshot a hidden Electron window that draws with WebGPU? (UI test harness)
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan');

const draw = `(async () => {
  document.body.style.cssText = 'margin:0;background:#223;color:#fff;font:20px sans-serif';
  document.body.innerHTML = '<div style="padding:8px">DOM text above canvas</div><canvas id="c" width="600" height="300" style="width:600px;height:300px"></canvas>';
  const a = await navigator.gpu.requestAdapter(); const d = await a.requestDevice();
  const cv = document.getElementById('c'); const ctx = cv.getContext('webgpu');
  const fmt = navigator.gpu.getPreferredCanvasFormat(); ctx.configure({ device: d, format: fmt, alphaMode: 'opaque' });
  const m = d.createShaderModule({ code: \`
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { let p = array(vec2f(-0.8,-0.8), vec2f(0.8,-0.8), vec2f(0.0,0.8)); return vec4f(p[i], 0, 1); }
    @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f { return vec4f(p.x / 600.0, p.y / 300.0, 0.2, 1); }\` });
  const pl = d.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: fmt }] } });
  const frame = () => {
    const e = d.createCommandEncoder();
    const p = e.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.05, g: 0.3, b: 0.1, a: 1 } }] });
    p.setPipeline(pl); p.draw(3); p.end(); d.queue.submit([e.finish()]);
  };
  frame(); await new Promise(r => requestAnimationFrame(() => { frame(); requestAnimationFrame(r); }));
  return a.info.vendor;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: process.env.SPIKE_SHOW === '1', width: 640, height: 400, webPreferences: { contextIsolation: true } });
  await win.loadFile(path.join(__dirname, 'blank.html'));
  const vendor = await win.webContents.executeJavaScript(draw);
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  fs.mkdirSync('test-output', { recursive: true });
  fs.writeFileSync('test-output/electron-shot.png', img.toPNG());
  console.log('SHOT vendor=' + vendor + ' size=' + JSON.stringify(img.getSize()) + ' empty=' + img.isEmpty());
  app.quit();
});
setTimeout(() => { console.log('SHOT timeout'); app.exit(1); }, 30000);
