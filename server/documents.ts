import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateHTML, generateJSON } from '@tiptap/html/server';
import sanitizeHtml from 'sanitize-html';
import { Transform } from '@tiptap/pm/transform';
import { Slice, type Node as PMNode } from '@tiptap/pm/model';
import { schema, editorExtensions } from '../shared/editor.ts';
import type { Note, Discussion, Proposal, Content, NoteSummary, Message } from '../shared/types.ts';

export class AppError extends Error { constructor(public status: number, message: string) { super(message); } }
export const now = () => new Date().toISOString();
export function validateContent(content: Content): PMNode {
  try {
    const node = schema.nodeFromJSON(content); node.check();
    if (node.type.name !== 'doc' || JSON.stringify(content).length > 2_000_000) throw new Error('size');
    node.descendants(n => {
      for (const m of n.marks) {
        if (m.type.name === 'link' && !/^(https?:|mailto:|#)/i.test(String(m.attrs.href))) throw new Error('unsafe link');
        if (m.type.name === 'annotation' && (!Array.isArray(m.attrs.threadIds) || m.attrs.threadIds.some((x: unknown)=>typeof x !== 'string'))) throw new Error('annotation');
      }
      if (n.type.name === 'image' && !/^https?:\/\//i.test(String(n.attrs.src))) throw new Error('unsafe image');
    });
    return node;
  } catch { throw new AppError(400, '文档格式无效，未保存。'); }
}
export function cleanHTML(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p','h1','h2','h3','h4','h5','h6','strong','b','em','i','u','s','del','mark','ul','ol','li','blockquote','pre','code','br','hr','a','table','thead','tbody','tr','th','td','img'],
    allowedAttributes: { a:['href','title'], img:['src','alt','title'], mark:['data-color'], ol:['start'], td:['colspan','rowspan'],th:['colspan','rowspan'],code:['class'] },
    allowedSchemes: ['http','https','mailto'], allowProtocolRelative: false,
  });
}
export function fromHTML(html: string): Content {
  if (html.length > 500_000) throw new AppError(400, '内容过长，请分章节生成。');
  const content = generateJSON(cleanHTML(html), editorExtensions());
  validateContent(content); return content;
}
export const toHTML = (content: Content) => generateHTML(content, editorExtensions());
export function threadRange(node: PMNode, threadId: string): {from: number; to:number; text: string} | null {
  const ranges: {from:number;to:number}[] = [];
  node.descendants((n,pos)=> {
    if (n.isInline && n.marks.some(m => m.type.name === 'annotation' && m.attrs.threadIds.includes(threadId))) ranges.push({from:pos,to:pos+n.nodeSize});
  });
  if (!ranges.length) return null;
  const from=ranges[0].from,to=ranges[ranges.length-1].to;
  // Adjacent marks may span formatting and paragraph boundaries. Any unmarked
  // inline content between them means this ID is split/duplicated, not one range.
  let ambiguous=false;
  node.nodesBetween(from,to,n=> {
    if(n.isInline&&!n.marks.some(m=>m.type.name==='annotation'&&m.attrs.threadIds.includes(threadId))) ambiguous=true;
  });
  return ambiguous?null:{from,to,text:node.textBetween(from,to,'\n')};
}
function annotate(node: PMNode, from: number, to: number, id: string): PMNode {
  const tr = new Transform(node);
  node.nodesBetween(from,to,(n,pos)=> {
    if (!n.isInline) return;
    const ids = n.marks.find(m=>m.type.name==='annotation')?.attrs.threadIds || [];
    tr.addMark(Math.max(from,pos),Math.min(to,pos+n.nodeSize),schema.marks.annotation.create({threadIds:[...new Set([...ids,id])]}));
  });
  return tr.doc;
}
export function preserveDiscussionAnchors(old:Note,content:Content):Content {
 let node=validateContent(content);const previous=validateContent(old.content);
 // Reattach only a single exact occurrence; ambiguous matches remain detached.
 let text='',positions:number[]=[],lastEnd=-1;
 node.descendants((n,pos)=>{if(n.isText){if(lastEnd>=0&&pos>lastEnd){text+='\n';positions.push(-1);}for(let i=0;i<n.text!.length;i++){text+=n.text![i];positions.push(pos+i);}lastEnd=pos+n.nodeSize;}});
 for(const t of old.threads){const range=threadRange(previous,t.id);if(!range)continue;const start=text.indexOf(range.text);if(start<0||text.indexOf(range.text,start+1)>=0)continue;const from=positions[start],to=positions[start+range.text.length-1]+1;if(from>=0&&to>from)node=annotate(node,from,to,t.id);}
 // Markdown cannot carry user highlights; retain them only on unique exact text.
 previous.descendants(n=>{const highlight=n.marks.find(m=>m.type.name==='highlight');if(!n.isText||!highlight)return;const at=text.indexOf(n.text!);if(at<0||text.indexOf(n.text!,at+1)>=0)return;const from=positions[at],to=positions[at+n.text!.length-1]+1;if(from>=0&&to>from)node=new Transform(node).addMark(from,to,highlight).doc;});
 return node.toJSON();
}
export class DocumentStore {
  db: DatabaseSync;
  constructor(dataDir: string, seed = true) {
    mkdirSync(dataDir,{recursive:true,mode:0o700});
    this.db = new DatabaseSync(join(dataDir,'notes.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL,source_url TEXT);
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id),quote TEXT NOT NULL,created_at TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES threads(id),role TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id),thread_id TEXT NOT NULL REFERENCES threads(id),base_revision INTEGER NOT NULL,original TEXT NOT NULL,replacement TEXT NOT NULL,explanation TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT,note_id TEXT NOT NULL REFERENCES notes(id),title TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,kind TEXT NOT NULL);`);
    const columns=this.db.prepare('PRAGMA table_info(history)').all() as {name:string}[];
    if(!columns.some(c=>c.name==='proposal_id'))this.db.exec('ALTER TABLE history ADD COLUMN proposal_id TEXT');
    if(!columns.some(c=>c.name==='applied_revision'))this.db.exec('ALTER TABLE history ADD COLUMN applied_revision INTEGER');
    // Freeze the existing library order once. Reading, editing and sync must not reorder it.
    this.db.exec(`CREATE TABLE IF NOT EXISTS library_order(position INTEGER PRIMARY KEY AUTOINCREMENT,note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE);
      INSERT INTO library_order(note_id) SELECT id FROM notes WHERE id NOT IN (SELECT note_id FROM library_order) ORDER BY updated_at DESC,rowid DESC;
      CREATE TRIGGER IF NOT EXISTS append_library_note AFTER INSERT ON notes BEGIN INSERT INTO library_order(note_id) VALUES(NEW.id); END;`);
    if (seed && !(this.db.prepare('SELECT id FROM notes LIMIT 1').get())) this.create('从这里开始，让知识慢慢长出来', fromHTML(`<h2>属于你的学习文档</h2><p>PaperMind把阅读、思考和写作放在同一份文档里。你可以自己写，也可以和 AI 一起把一个主题讲清楚。</p><blockquote><p>这是一份使用说明，不是 AI 生成结果。随时修改它，或者新建自己的第一篇笔记。</p></blockquote><h2>从一个问题开始</h2><p>在 Codex 或其他 Agent 中生成学习笔记，再通过PaperMind CLI 交付；也可从左侧新建空白文档。阅读时点击右上角「AI」，围绕当前文章提问。</p><h2>在原文旁边想明白</h2><p>选中这句话，试试高亮或「问 AI」。问题会和原文放在一起，之后可以继续追问，不用反复复制粘贴。</p><p>讨论清楚后，点击「讨论融入正文」，直接补充、完善选中段落并保存；不满意可以撤销。</p><h2>文档会留下来</h2><p>正文、高亮和讨论保存在这台电脑。关闭浏览器后重新打开，仍然可以接着学习。</p>`));
  }
  tx<T>(f:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try { const r=f();this.db.exec('COMMIT');return r; } catch(e){this.db.exec('ROLLBACK');throw e;} }
  list():NoteSummary[] { return this.db.prepare('SELECT n.id,n.title,n.updated_at AS updatedAt,n.revision FROM notes n JOIN library_order o ON o.note_id=n.id ORDER BY o.position').all() as unknown as NoteSummary[]; }
  get(id:string):Note {
    const row = this.db.prepare('SELECT * FROM notes WHERE id=?').get(id) as any;
    if(!row) throw new AppError(404,'文档不存在。');
    const content=JSON.parse(row.content), node=validateContent(content);
    const threads=(this.db.prepare('SELECT * FROM threads WHERE note_id=? ORDER BY created_at').all(id) as any[]).map(t=> ({
      id:t.id, quote:t.quote, createdAt:t.created_at, resolved:!!t.resolved, detached:!threadRange(node,t.id),
      messages:this.db.prepare('SELECT id,role,text,created_at AS createdAt FROM messages WHERE thread_id=? ORDER BY rowid').all(t.id) as unknown as Message[],
      proposals:this.db.prepare('SELECT id,thread_id AS threadId,base_revision AS baseRevision,original,replacement AS replacementHtml,explanation,state FROM proposals WHERE thread_id=? ORDER BY rowid').all(t.id) as unknown as Proposal[],
    })) as Discussion[];
    const latest=this.db.prepare('SELECT kind,proposal_id,applied_revision FROM history WHERE note_id=? ORDER BY id DESC LIMIT 1').get(id) as any;
    for(const t of threads)for(const p of t.proposals)p.canUndo=p.state==='applied'&&latest?.kind==='ai'&&latest.proposal_id===p.id&&latest.applied_revision===row.revision;
    return {id,title:row.title,content,revision:row.revision,updatedAt:row.updated_at,threads,sourceUrl:row.source_url||undefined};
  }
  create(title:string,content:Content={type:'doc',content:[{type:'paragraph'}]},sourceUrl?:string):Note {
    validateContent(content);const id=randomUUID();
    this.db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?)').run(id,title.trim()||'未命名文档',JSON.stringify(content),1,now(),sourceUrl||null);
    return this.get(id);
  }
  assertRevision(note:Note,revision:number) { if (note.revision!==revision) throw new AppError(409,'文档已更新。请重新载入最新内容后再操作，当前修改没有覆盖原文。'); }
  write(note:Note,title:string,content:Content,kind:string,saveHistory=true,proposalId?:string):Note {
    validateContent(content);
    if(saveHistory) this.db.prepare('INSERT INTO history(note_id,title,content,created_at,kind,proposal_id,applied_revision) VALUES(?,?,?,?,?,?,?)').run(note.id,note.title,JSON.stringify(note.content),now(),kind,proposalId||null,note.revision+1);
    this.db.prepare('UPDATE notes SET title=?,content=?,revision=revision+1,updated_at=? WHERE id=?').run(title.trim()||'未命名文档',JSON.stringify(content),now(),note.id);
    return this.get(note.id);
  }
  save(id:string,revision:number,title:string,content:Content):Note { return this.tx(()=>{const n=this.get(id);this.assertRevision(n,revision);return this.write(n,title,content,'edit');}); }
  addThread(id:string,revision:number,from:number,to:number,quote:string):{note:Note;threadId:string} {
    return this.tx(()=> {
      const n=this.get(id);this.assertRevision(n,revision);const node=validateContent(n.content);
      if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to>node.content.size||to<=from||node.textBetween(from,to,'\n')!==quote||!quote.trim()) throw new AppError(400,'选区已变化，请重新选中文字。');
      const threadId=randomUUID();this.db.prepare('INSERT INTO threads(id,note_id,quote,created_at) VALUES(?,?,?,?)').run(threadId,id,quote,now());
      return {note:this.write(n,n.title,annotate(node,from,to,threadId).toJSON(),'annotation',false),threadId};
    });
  }
  addMessage(noteId:string,threadId:string,role:'user'|'assistant',text:string) {
    if(!this.get(noteId).threads.some(t=>t.id===threadId)) throw new AppError(404,'讨论不存在。');
    this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(randomUUID(),threadId,role,text,now());
  }
  propose(noteId:string,threadId:string,baseRevision:number,original:string,replacementHtml:string,explanation:string):Proposal {
    const n=this.get(noteId);this.assertRevision(n,baseRevision);
    if(!n.threads.some(t=>t.id===threadId))throw new AppError(404,'讨论不存在。');
    const range=threadRange(validateContent(n.content),threadId);
    if(!range||range.text!==original)throw new AppError(409,'原文已变化，需基于最新原文重新生成修改建议。');
    const html=cleanHTML(replacementHtml);if(!fromHTML(html).content?.length) throw new AppError(400,'修改内容为空。');
    const p:Proposal={id:randomUUID(),threadId,baseRevision,original,replacementHtml:html,explanation,state:'pending'};
    this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?)').run(p.id,noteId,threadId,baseRevision,original,html,explanation,'pending');
    return p;
  }
  writeback(noteId:string,threadId:string,revision:number,original:string,replacement:string,explanation:string):Note {
    return this.tx(()=>{const p=this.propose(noteId,threadId,revision,original,replacement,explanation);return this.applyChange(noteId,p.id,revision);});
  }
  apply(id:string,proposalId:string,revision:number):Note { return this.tx(()=>this.applyChange(id,proposalId,revision)); }
  private applyChange(id:string,proposalId:string,revision:number):Note {
    const n=this.get(id);this.assertRevision(n,revision);
    const p=n.threads.flatMap(t=>t.proposals).find(p=>p.id===proposalId);
    if(!p||p.state!=='pending') throw new AppError(409,'修改建议不存在或已处理。');
    this.assertRevision(n,p.baseRevision);
    const node=validateContent(n.content),r=threadRange(node,p.threadId);
    if(!r||r.text!==p.original)throw new AppError(409,'对应原文已变化，请重新生成建议。');
    // Table cells are independently structured containers. Refuse selections
    // crossing their boundaries instead of asking ProseMirror to silently fit them.
    const cellAt=(pos:number)=>{const resolved=node.resolve(pos);for(let d=resolved.depth;d>0;d--)if(['tableCell','tableHeader'].includes(resolved.node(d).type.name))return resolved.before(d);return null;};
    const firstCell=cellAt(r.from),lastCell=cellAt(r.to);
    let touchesCell=false;
    node.nodesBetween(r.from,r.to,n=>{if(['tableCell','tableHeader'].includes(n.type.name))touchesCell=true;});
    if(firstCell!==lastCell||(touchesCell&&firstCell===null))throw new AppError(409,'选区跨越表格单元格边界，请只选中一个单元格内的原文后重试。');
    const replacement=validateContent(fromHTML(p.replacementHtml));
    const singleParagraph=replacement.childCount===1&&replacement.firstChild!.type.name==='paragraph';
    // Only a single ordinary paragraph is an inline replacement. Closed slices
    // preserve all list/table/heading wrappers and keep unselected text outside.
    const slice=singleParagraph?new Slice(replacement.firstChild!.content,0,0):new Slice(replacement.content,0,0);
    const tr=new Transform(node);
    try{tr.replaceRange(r.from,r.to,slice);}catch{throw new AppError(409,'此选区无法安全容纳修改结构，请调整选区后重试。');}
    const start=tr.mapping.map(r.from,-1),end=tr.mapping.map(r.to,1);
    let edited=annotate(tr.doc,Math.max(0,start),Math.min(tr.doc.content.size,end),p.threadId);
    const appliedRange=threadRange(edited,p.threadId);
    const expectedText=replacement.textBetween(0,replacement.content.size,'\n');
    // Some node types (e.g. code blocks) disallow marks. Never report success if
    // the new document would lose the discussion or include unselected content.
    if(!appliedRange||appliedRange.text!==expectedText)throw new AppError(409,'修改后的内容无法保持准确讨论定位，请调整修改内容后重试。');
    const result=this.write(n,n.title,edited.toJSON(),'ai',true,p.id);
    this.db.prepare("UPDATE proposals SET state='applied' WHERE id=?").run(p.id);
    return this.get(result.id);
  }
  undo(id:string,revision:number,proposalId?:string):Note { return this.tx(()=>{
    const n=this.get(id);this.assertRevision(n,revision);
    const prev=this.db.prepare('SELECT * FROM history WHERE note_id=? ORDER BY id DESC LIMIT 1').get(id) as any;
    if(!prev) throw new AppError(409,'没有可以撤销的 AI 修改。');
    if(prev.kind!=='ai'||!prev.proposal_id||prev.applied_revision!==n.revision||(proposalId&&prev.proposal_id!==proposalId))throw new AppError(409,'此 AI 修改之后文档已有新变化，不能直接撤销。你的后续编辑已保留。');
    const proposal=this.db.prepare('SELECT state FROM proposals WHERE id=? AND note_id=?').get(prev.proposal_id,id) as {state:string}|undefined;
    if(proposal?.state!=='applied')throw new AppError(409,'这条 AI 修改已撤销或无法撤销。');
    this.write(n,prev.title,JSON.parse(prev.content),'undo',false);
    this.db.prepare("UPDATE proposals SET state='undone' WHERE id=?").run(prev.proposal_id);
    this.db.prepare('DELETE FROM history WHERE id=?').run(prev.id);
    return this.get(id);
  }); }
  // Caller owns the transaction so a multi-document restore is all-or-nothing.
  restoreBundle(remote:Note,copy=false):Note {
    const id=copy?randomUUID():remote.id;
    const existing=this.db.prepare('SELECT id FROM notes WHERE id=?').get(id)?this.get(id):null;
    const threadIds=new Map(remote.threads.map(t=>[t.id,copy?randomUUID():t.id]));
    const content=structuredClone(remote.content);
    const remap=(node:Content)=>{for(const m of node.marks||[])if(m.type==='annotation')m.attrs={...m.attrs,threadIds:(m.attrs?.threadIds||[]).map((x:string)=>threadIds.get(x)||x)};node.content?.forEach(remap);};remap(content);validateContent(content);
    for(const t of remote.threads){const owner=this.db.prepare('SELECT note_id FROM threads WHERE id=?').get(threadIds.get(t.id)!) as {note_id:string}|undefined;if(owner&&owner.note_id!==id)throw new AppError(409,'远端讨论 ID 与其他本机文档冲突。');}
    if(existing){this.write(existing,remote.title,content,'github-pull');this.db.prepare('UPDATE notes SET source_url=? WHERE id=?').run(remote.sourceUrl||null,id);this.db.prepare('DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE note_id=?)').run(id);this.db.prepare('DELETE FROM proposals WHERE note_id=?').run(id);this.db.prepare('DELETE FROM threads WHERE note_id=?').run(id);}
    else this.db.prepare('INSERT INTO notes VALUES(?,?,?,?,?,?)').run(id,remote.title,JSON.stringify(content),1,now(),remote.sourceUrl||null);
    const revision=this.get(id).revision;
    for(const t of remote.threads){const tid=threadIds.get(t.id)!;this.db.prepare('INSERT INTO threads(id,note_id,quote,created_at,resolved) VALUES(?,?,?,?,?)').run(tid,id,t.quote,t.createdAt,t.resolved?1:0);
      for(const m of t.messages)this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(copy?randomUUID():m.id,tid,m.role,m.text,m.createdAt);
      // Pending edits target an old machine revision and must be regenerated.
      for(const p of t.proposals)this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?)').run(copy?randomUUID():p.id,id,tid,p.state==='pending'?revision:p.baseRevision,p.original,p.replacementHtml,p.explanation,p.state==='pending'?'rejected':p.state);
    }
    return this.get(id);
  }
  close(){this.db.close();}
}
