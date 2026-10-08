import { parentPort, workerData } from 'node:worker_threads';
import { JSDOM } from 'jsdom';

// Mermaid's parser sanitizes labels through DOMPurify. Isolate its DOM and
// global configuration from the HTTP server; no scripts or resources load.
const dom = new JSDOM('');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
try {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, maxEdges: 200, maxTextSize: 20_000 });
  for (let index = 0; index < workerData.length; index++) {
    try { await mermaid.parse(workerData[index]); }
    catch { parentPort.postMessage({ error: `第 ${index + 1} 张关系图语法无效，请修正 Mermaid 图稿后重新导入。` }); process.exit(0); }
  }
  parentPort.postMessage({ valid: true });
} catch { parentPort.postMessage({ error: '图表校验未完成，请检查安装并重试。' }); }
finally { dom.window.close(); }
