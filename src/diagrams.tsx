import { useEffect, useRef } from 'react';
import type { NodeViewRenderer } from '@tiptap/core';
import CodeBlock from '@tiptap/extension-code-block';
import DOMPurify from 'dompurify';
import { assertDiagramSource, diagramLimits, isMermaid } from '../shared/diagrams';

let sequence = 0;
const loadMermaid = () => import('mermaid').then(({ default: mermaid }) => {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: false }, maxEdges: diagramLimits.edges, maxTextSize: diagramLimits.length, suppressErrorRendering: true });
  return mermaid;
});
let engine: ReturnType<typeof loadMermaid> | undefined;
export function renderDiagram(container: HTMLElement, source: string) {
  let active = true;
  container.dataset.diagramState = 'loading';
  container.dataset.zoom = 'fit';
  container.textContent = '正在绘制关系图…';
  (async () => {
    try {
      assertDiagramSource(source);
      const mermaid = await (engine ||= loadMermaid());
      const { svg } = await mermaid.render(`papermind-diagram-${++sequence}`, source);
      if (!active) return;
      container.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'image', 'a', 'script'] });
      const drawing = container.querySelector('svg');
      if (!drawing) throw new Error('未生成可显示的图。');
      drawing.setAttribute('role', 'img');
      drawing.setAttribute('aria-label', '关系图');
      const zoom = document.createElement('button');
      zoom.type = 'button'; zoom.className = 'diagram-zoom'; zoom.textContent = '原始大小';
      zoom.addEventListener('click', () => {
        const original = container.dataset.zoom !== 'original';
        container.dataset.zoom = original ? 'original' : 'fit';
        zoom.textContent = original ? '适应宽度' : '原始大小';
      });
      container.prepend(zoom);
      container.dataset.diagramState = 'rendered';
    } catch (error) {
      if (!active) return;
      container.dataset.diagramState = 'error';
      container.textContent = `关系图未能显示。${error instanceof Error && !/Parse error|Syntax error/i.test(error.message) ? error.message : '请检查 Mermaid 语法。'}请修正图稿后重试。`;
    }
  })();
  return () => { active = false; };
}

export function Diagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => renderDiagram(ref.current!, source), [source]);
  return <div ref={ref} className="diagram-preview" aria-live="polite" />;
}

const codeView: NodeViewRenderer = ({ node }) => {
  const diagram = isMermaid(node.attrs.language);
  const code = document.createElement('code'), pre = document.createElement('pre');
  pre.append(code);
  if (!diagram) return { dom: pre, contentDOM: code, update: next => next.type === node.type && !isMermaid(next.attrs.language) };
  const dom = document.createElement('div'); dom.className = 'diagram-block';
  const preview = document.createElement('div'); preview.className = 'diagram-preview'; preview.contentEditable = 'false'; preview.setAttribute('aria-live', 'polite');
  const details = document.createElement('details'), summary = document.createElement('summary');
  summary.textContent = '编辑图稿'; summary.contentEditable = 'false';
  details.append(summary, pre); dom.append(preview, details);
  let source = node.textContent, dispose = renderDiagram(preview, source);
  return {
    dom, contentDOM: code,
    update(next) {
      if (next.type !== node.type || !isMermaid(next.attrs.language)) return false;
      if (next.textContent !== source) { source = next.textContent; dispose(); dispose = renderDiagram(preview, source); }
      return true;
    },
    ignoreMutation: mutation => mutation.type !== 'selection' && !code.contains(mutation.target),
    stopEvent: event => preview.contains(event.target as globalThis.Node) || summary.contains(event.target as globalThis.Node),
    destroy: () => dispose(),
  };
};
export const RenderedCodeBlock = CodeBlock.extend({ marks: 'annotation', addNodeView() { return codeView; } });
