import type { Content } from './types.ts';

export const diagramLimits = { count: 20, length: 20_000, edges: 200 };
export const isMermaid = (language: unknown) => String(language || '').trim().toLowerCase() === 'mermaid';
export function diagramSources(content: Content): string[] {
  const result: string[] = [];
  const visit = (node: Content) => {
    if (node.type === 'codeBlock' && isMermaid(node.attrs?.language)) result.push((node.content || []).map(n => n.text || '').join(''));
    node.content?.forEach(visit);
  };
  visit(content);
  return result;
}
// Keep configuration and resource loading under the application's control.
export function assertDiagramSource(source: string) {
  if (!source.trim() || source.length > diagramLimits.length) throw new Error('图稿为空或超过 20,000 字符，请拆成小图。');
  if (/%%\s*\{|^\s*---|\bclick\s|url\s*\(|@import|<\/?[a-z][^>]*>|(?:https?:|data:|javascript:)/im.test(source)) throw new Error('图稿不能包含配置指令、HTML、点击操作或外部资源，请使用文字节点和连线。');
  if (!/^\s*(?:%%[^\n]*\n\s*)*(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\b/i.test(source)) throw new Error('目前支持 Mermaid flowchart / graph 关系图，请指定 TD 或 LR 等方向。');
}
