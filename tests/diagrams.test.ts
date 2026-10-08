import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../server/app.ts';
import { DocumentStore, validateContent } from '../server/documents.ts';
import { parseTextDocument } from '../server/transfer.ts';
import { validateDiagrams } from '../server/diagrams.ts';
import { diagramSources } from '../shared/diagrams.ts';
import { createIntegrationService, exportMarkdown } from '../server/integrations.ts';
import { FakeGithub } from './helpers/github.ts';

const source = 'flowchart LR\n A[原始资料] -->|提取字段| B[正式记录]\n B -->|构建索引| C[搜索文档]\n Q[搜索条件] --> C\n C -->|返回编号| B\n B -->|组成卡片| U[读者]';
const markdown = `# 系统关系\n\n图旁的这段文字可以讨论。\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\n搜索文档帮助找回编号，正式记录提供完整内容。`;

test('图稿经过 Markdown、JSON、导出再导入与重启后完整保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'papermind-diagram-'));
  let store = new DocumentStore(dir, false);
  try {
    const parsed = parseTextDocument(markdown, 'markdown');
    assert.deepEqual(await validateDiagrams(parsed.content), { count: 1, syntax: 'valid', display: 'pending_browser' });
    const note = store.create(parsed.title, parsed.content);
    const roundtrip = parseTextDocument(exportMarkdown(note), 'markdown');
    assert.deepEqual(diagramSources(roundtrip.content), diagramSources(note.content));
    store.close(); store = new DocumentStore(dir, false);
    assert.deepEqual(store.get(note.id).content, note.content);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('导入错误图明确失败且不创建或覆盖正文；普通代码不当作图', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'papermind-diagram-api-'));
  const { app, store } = await createApp(dir), server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const { token } = await (await fetch(base + '/api/session')).json() as any;
    const send = (body: object) => fetch(base + '/api/agent/documents', { method: 'POST', headers: { 'content-type': 'application/json', 'x-study-token': token }, body: JSON.stringify(body) });
    const valid = await send({ body: markdown, key: 'diagram-test' });
    assert.equal(valid.status, 201);
    const result = await valid.json() as any;
    assert.equal(result.diagrams.count, 1); assert.equal(result.diagrams.display, 'pending_browser');
    const before = store.get(result.note.id), count = store.list().length;
    for (const text of ['flowchart TD\n A[未闭合', '%%{init: {securityLevel: "loose"}}%%\nflowchart TD\nA --> B', 'flowchart TD\n A[正文] --> B[<img src=x onerror=alert(1)>]', 'sequenceDiagram\n A->>B: hello']) {
      const body = `# 不应保存\n\n\`\`\`mermaid\n${text}\n\`\`\``;
      const response = await send({ body, id: before.id, revision: before.revision });
      assert.equal(response.status, 400); assert.match(JSON.stringify(await response.json()), /关系图/);
      assert.deepEqual(store.get(before.id), before); assert.equal(store.list().length, count);
    }
    const code = parseTextDocument('# 代码\n\n```js\nconst x = 1;\n```', 'markdown');
    assert.equal((await validateDiagrams(code.content)).count, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('通过实际同步代码往返图稿及图旁讨论，README 外部编辑也能恢复图', async () => {
  const a = await mkdtemp(join(tmpdir(), 'papermind-graph-a-')), b = await mkdtemp(join(tmpdir(), 'papermind-graph-b-'));
  const first = new DocumentStore(a, false), second = new DocumentStore(b, false), github = new FakeGithub();
  try {
    const parsed = parseTextDocument(markdown, 'markdown'), note = first.create(parsed.title, parsed.content);
    let from = 0; const quote = '图旁的这段文字可以讨论。';
    validateContent(note.content).descendants((node, pos) => { if (node.text === quote) from = pos; });
    const thread = first.addThread(note.id, note.revision, from, from + quote.length, quote);
    first.addMessage(note.id, thread.threadId, 'user', '为什么先找编号？');
    const local = await createIntegrationService(first, a, { github });
    await local.push((await local.syncPreview({ repo: 'owner/repo', folder: 'notes', noteIds: [note.id] })).previewId);
    assert.match(github.files.get(`notes/${note.id}/README.md`)!, /```mermaid/);
    assert.match(github.files.get(`notes/${note.id}/document.json`)!, /mermaid/);
    const remote = await createIntegrationService(second, b, { github });
    await remote.pull((await remote.pullPreview({ repo: 'owner/repo', folder: 'notes' })).previewId);
    const restored = second.get(note.id);
    assert.deepEqual(diagramSources(restored.content), diagramSources(first.get(note.id).content));
    assert.equal(restored.threads[0].detached, false);
    assert.equal(restored.threads[0].messages[0].text, '为什么先找编号？');
    const path = `notes/${note.id}/README.md`, changed = exportMarkdown(restored).replace('原始资料', '新资料');
    github.files.set(path, changed);
    await github.request('POST', 'repos/owner/repo/git/blobs', {content: changed});
    const preview = await remote.pullPreview({repo: 'owner/repo', folder: 'notes'});
    assert.match(preview.items[0].warnings.join(), /README/);
    await remote.pull(preview.previewId);
    const edited = second.get(note.id);
    assert.match(diagramSources(edited.content)[0], /新资料/);
    assert.equal(edited.threads[0].detached, false);
    assert.equal((await validateDiagrams(edited.content)).syntax, 'valid');
  } finally { first.close(); second.close(); await rm(a, { recursive: true, force: true }); await rm(b, { recursive: true, force: true }); }
});
