import type { Express } from 'express';
import { marked } from 'marked';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppError, DocumentStore, fromHTML, validateContent, preserveDiscussionAnchors, cleanHTML } from './documents.ts';
import type { Note, Content } from '../shared/types.ts';

export function parseTextDocument(body:string,format:'markdown'|'html',title?:string) {
 let text=body;let inferred='未命名文档';
 if(format==='markdown'){const first=text.match(/^\s*# ([^\n]+)\n?/);if(first){inferred=first[1].trim();text=text.slice(first[0].length);}}
 const content=fromHTML(format==='markdown'?marked.parse(text,{async:false}):text);
 if(!validateContent(content).textContent.trim())throw new AppError(400,'文档正文不能为空。');
 return {title:title?.trim()||inferred,content};
}
const uuid=z.string().uuid(),date=z.string().datetime({offset:true});
const proposal=z.object({id:uuid,threadId:uuid,baseRevision:z.number().int().positive(),original:z.string().max(500000),replacementHtml:z.string().max(500000),explanation:z.string().max(30000),state:z.enum(['pending','applied','rejected','undone'])});
const chatMessage=z.object({id:uuid,role:z.enum(['user','assistant']),text:z.string().max(200000),createdAt:date});
const discussion=z.object({id:uuid,quote:z.string().max(500000),createdAt:date,resolved:z.boolean(),messages:z.array(z.object({id:uuid,role:z.enum(['user','assistant']),text:z.string().max(200000),createdAt:date})).max(10000),proposals:z.array(proposal).max(10000)});
export function decodeBundle(documentText:string,commentsText:string):Note {
 const document=z.object({format:z.literal('yejian-document-v1'),id:uuid,title:z.string().max(200),revision:z.number().int().positive(),updatedAt:date,sourceUrl:z.string().url().refine(v=>/^https?:\/\//.test(v)).optional(),content:z.record(z.string(),z.unknown())}).parse(JSON.parse(documentText));
 const comments=z.object({format:z.literal('yejian-discussions-v1'),noteId:uuid,threads:z.array(discussion).max(1000),documentMessages:z.array(chatMessage).max(10000).optional()}).parse(JSON.parse(commentsText));
 if(comments.noteId!==document.id)throw new AppError(400,'正文与讨论属于不同文档。');
 const content=document.content as Content;validateContent(content);
 const allIds=new Set<string>();for(const t of comments.threads){for(const id of [t.id,...t.messages.map(m=>m.id),...t.proposals.map(p=>p.id)]){if(allIds.has(id))throw new AppError(400,'远端讨论包含重复 ID。');allIds.add(id);}for(const p of t.proposals){if(p.threadId!==t.id)throw new AppError(400,'修改记录与讨论不匹配。');p.replacementHtml=cleanHTML(p.replacementHtml);}}
 const known=new Set(comments.threads.map(t=>t.id));validateContent(content).descendants(n=>{for(const m of n.marks)if(m.type.name==='annotation'&&m.attrs.threadIds.some((id:string)=>!known.has(id)))throw new AppError(400,'正文批注缺少对应的讨论文件。');});
 return {...document,content,documentMessages:comments.documentMessages,threads:comments.threads.map(t=>({...t,detached:false}))};
}
// Ignore machine-local revision/timestamps and derived UI flags for synchronization.
export function noteFingerprint(note:Note):string {
 return createHash('sha256').update(JSON.stringify({id:note.id,title:note.title,sourceUrl:note.sourceUrl||null,content:note.content,documentMessages:note.documentMessages||[],threads:note.threads.map(t=>({id:t.id,quote:t.quote,createdAt:t.createdAt,resolved:t.resolved,messages:t.messages,proposals:t.proposals.map(({canUndo,...p})=>p)}))})).digest('hex');
}
export function installAgentRoutes(app:Express,store:DocumentStore) {
 store.db.exec('CREATE TABLE IF NOT EXISTS external_documents(source_key TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(id),source_hash TEXT NOT NULL)');
 app.post('/api/agent/documents',(req,res)=>{
  const input=z.object({body:z.string().min(1).max(500000),format:z.enum(['markdown','html']).default('markdown'),title:z.string().max(200).optional(),id:uuid.optional(),revision:z.number().int().positive().optional(),key:z.string().min(1).max(1000).optional()}).parse(req.body);
  const parsed=parseTextDocument(input.body,input.format,input.title),digest=createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
  const result=store.tx(()=>{
   const record=input.key?store.db.prepare('SELECT note_id,source_hash FROM external_documents WHERE source_key=?').get(input.key) as {note_id:string;source_hash:string}|undefined:undefined;
   if(record&&input.id&&record.note_id!==input.id)throw new AppError(409,'这个交付标识已关联另一篇文档。');
   const id=input.id||record?.note_id;
   if(id){const old=store.get(id);if(record?.source_hash===digest)return {note:old,created:false,warnings:[]};if(input.revision===undefined)throw new AppError(409,`已有同一篇文档（${id}），请先读取它并提供 revision 后再更新。`);store.assertRevision(old,input.revision);
    const content=preserveDiscussionAnchors(old,parsed.content);const n=store.write(old,parsed.title==='未命名文档'?old.title:parsed.title,content,'external-agent');
    if(input.key)store.db.prepare('INSERT INTO external_documents VALUES(?,?,?) ON CONFLICT(source_key) DO UPDATE SET source_hash=excluded.source_hash').run(input.key,id,digest);
    return {note:n,created:false,warnings:n.threads.some(t=>t.detached)?['部分原文已变化，相关讨论仍保留，但需要重新选择原文才能写回。']:[]};
   }
   const note=store.create(parsed.title,parsed.content);if(input.key)store.db.prepare('INSERT INTO external_documents VALUES(?,?,?)').run(input.key,note.id,digest);return {note,created:true,warnings:[]};
  });
  res.status(result.created?201:200).json({...result,url:`/?note=${result.note.id}`});
 });
}
