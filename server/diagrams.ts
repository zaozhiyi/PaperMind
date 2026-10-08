import { Worker } from 'node:worker_threads';
import type { Content } from '../shared/types.ts';
import { assertDiagramSource, diagramSources, diagramLimits } from '../shared/diagrams.ts';
import { AppError } from './documents.ts';

export async function validateDiagrams(content: Content) {
  const sources = diagramSources(content);
  if (sources.length > diagramLimits.count) throw new AppError(400, '一篇文档最多包含 20 张关系图，请拆分文档。');
  sources.forEach((source, index) => {
    try { assertDiagramSource(source); } catch (error) { throw new AppError(400, `第 ${index + 1} 张关系图：${(error as Error).message}`); }
  });
  if (sources.length) await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./diagram-parser.mjs', import.meta.url), { workerData: sources, execArgv: [] });
    let settled = false;
    const finish = (error?: string) => { if (settled) return; settled = true; clearTimeout(timeout); void worker.terminate(); error ? reject(new AppError(400, error)) : resolve(); };
    const timeout = setTimeout(() => finish('图表校验超时，请简化关系图后重试。'), 15_000);
    worker.once('message', result => finish(result.valid ? undefined : result.error || '图表校验失败。'));
    worker.once('error', () => finish('图表校验服务失败，请检查安装并重试。'));
    worker.once('exit', code => { if (code !== 0) finish('图表校验未完成。'); });
  });
  return { count: sources.length, syntax: sources.length ? 'valid' : 'none', display: sources.length ? 'pending_browser' : 'none' };
}
