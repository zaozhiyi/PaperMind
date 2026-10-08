import { Mark, mergeAttributes, getSchema } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import CodeBlock from '@tiptap/extension-code-block';

export const Annotation = Mark.create({
  name: 'annotation', inclusive: false,
  addProseMirrorPlugins() {
    const name = this.name;
    const clean = (fragment: Fragment): Fragment => {
      const nodes: PMNode[] = [];
      fragment.forEach(node => nodes.push(node.copy(clean(node.content)).mark(node.marks.filter(mark => mark.type.name !== name))));
      return Fragment.fromArray(nodes);
    };
    return [new Plugin({ props: { transformPasted: slice => new Slice(clean(slice.content), slice.openStart, slice.openEnd) } })];
  },
  addAttributes() { return { threadIds: { default: [], parseHTML: el => (el.getAttribute('data-thread-ids') || '').split(' ').filter(Boolean), renderHTML: attrs => ({ 'data-thread-ids': (attrs.threadIds as string[]).join(' ') }) } }; },
  parseHTML() { return [{ tag: 'span[data-thread-ids]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes({class: 'annotation'}, HTMLAttributes), 0]; },
});
export const editorExtensions = (codeBlock = CodeBlock.extend({ marks: 'annotation' })) => [
  StarterKit.configure({ codeBlock: false, link: { openOnClick: false, autolink: true } }),
  codeBlock,
  Highlight.configure({ multicolor: true }), Annotation,
  Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
  Image.configure({ allowBase64: false }),
];
export const schema = getSchema(editorExtensions());
