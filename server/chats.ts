import type express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, DocumentStore, fromHTML, now, toHTML, validateContent } from './documents.ts';
import type { AIService } from './ai.ts';
import type { Message, Note } from '../shared/types.ts';

export interface Chat { documentId?: string; id: string; title: string; updatedAt: string; messages: Message[]; noteIds: string[] }
export class ChatStore {
  constructor(private store: DocumentStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,title TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),role TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_notes(chat_id TEXT NOT NULL REFERENCES chats(id),note_id TEXT NOT NULL REFERENCES notes(id),PRIMARY KEY(chat_id,note_id));
      CREATE TABLE IF NOT EXISTS document_chats(note_id TEXT PRIMARY KEY REFERENCES notes(id),chat_id TEXT UNIQUE NOT NULL REFERENCES chats(id));`);
  }
  list() { return this.store.db.prepare('SELECT id,title,updated_at AS updatedAt FROM chats ORDER BY updated_at DESC').all(); }
  get(id: string): Chat {
    const row=this.store.db.prepare('SELECT id,title,updated_at AS updatedAt FROM chats WHERE id=?').get(id);
    if(!row)throw new AppError(404,'对话不存在。');
    const scoped=this.store.db.prepare('SELECT note_id FROM document_chats WHERE chat_id=?').get(id) as {note_id:string}|undefined;
    return {...row,...(scoped?{documentId:scoped.note_id}:{}),messages:this.store.db.prepare('SELECT id,role,text,created_at AS createdAt FROM chat_messages WHERE chat_id=? ORDER BY rowid').all(id),noteIds:this.store.db.prepare('SELECT note_id FROM chat_notes WHERE chat_id=? ORDER BY rowid').all(id).map(r=>r.note_id)} as unknown as Chat;
  }
  create() {const id=randomUUID();this.store.db.prepare('INSERT INTO chats VALUES(?,?,?)').run(id,'新对话',now());return this.get(id);}
  forDocument(noteId:string,create=false):Chat|null {
    this.store.get(noteId);
    const row=this.store.db.prepare('SELECT chat_id FROM document_chats WHERE note_id=?').get(noteId) as {chat_id:string}|undefined;
    if(row)return this.get(row.chat_id);
    if(!create)return null;
    return this.store.tx(()=>{const chat=this.create();this.store.db.prepare('INSERT INTO document_chats VALUES(?,?)').run(noteId,chat.id);return this.get(chat.id);});
  }
  add(id:string,role:'user'|'assistant',text:string) {
    const c=this.get(id);this.store.tx(()=>{
      this.store.db.prepare('INSERT INTO chat_messages VALUES(?,?,?,?,?)').run(randomUUID(),id,role,text,now());
      this.store.db.prepare('UPDATE chats SET title=?,updated_at=? WHERE id=?').run(c.messages.length?c.title:text.slice(0,40),now(),id);
    });
  }
  link(id:string,noteId:string) {this.store.db.prepare('INSERT OR IGNORE INTO chat_notes VALUES(?,?)').run(id,noteId);}
}

export function installChatRoutes(app:express.Express,store:DocumentStore,ai:AIService) {
  const chats=new ChatStore(store),busy=new Set<string>();
  app.get('/api/notes/:id/chat',(req,res)=>res.json(chats.forDocument(req.params.id)));
  app.post('/api/notes/:id/chat',(req,res)=>res.json(chats.forDocument(req.params.id,true)));
  app.get('/api/chats',(_req,res)=>res.json(chats.list()));
  app.post('/api/chats',(_req,res)=>res.status(201).json(chats.create()));
  app.get('/api/chats/:id',(req,res)=>res.json(chats.get(req.params.id)));
  app.post('/api/chats/:id/message',async(req,res)=>{
    const {text,noteId}=z.object({text:z.string().trim().min(1).max(12000),noteId:z.string().uuid().optional()}).parse(req.body);
    const id=req.params.id,chat=chats.get(id);
    if(busy.has(id))throw new AppError(409,'当前对话仍在回复，请稍候。');
    if(!ai.status().ready)throw new AppError(409,'请先在设置中连接模型。');
    // Article discussions stay bound to their article; legacy generic chats use explicit context only.
    if(chat.documentId&&noteId&&noteId!==chat.documentId)throw new AppError(409,'这条讨论属于另一篇文档。');
    const doc=chat.documentId?store.get(chat.documentId):noteId?store.get(noteId):undefined;
    if(!chat.documentId&&chat.messages.length>=98)throw new AppError(400,'这段对话已很长，请新建对话继续。文档和历史会保留。');
    busy.add(id);chats.add(id,'user',text);
    res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','X-Accel-Buffering':'no'});res.flushHeaders();
    const controller=new AbortController();res.on('close',()=>controller.abort());
    const send=(event:string,data:unknown)=>{if(!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
    const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);
    let partial='',created:Note|undefined,recorded=false;
    try {
      const result=await ai.run({mode:chat.documentId?'chat':'workspace',signal:controller.signal,
        messages:[...(chat.documentId?chat.messages.slice(-40):chat.messages).map(m=>({role:m.role,content:m.text})),{role:'user',content:text}],
        context:doc?{document:{id:doc.id,title:doc.title,html:toHTML(doc.content),revision:doc.revision}}:{},
        onEvent:event=>{if(event.type==='delta'){partial+=event.text;send('text',{delta:event.text});}},
        tools:chat.documentId?{}:{createDocument:async({title,html})=>{
          controller.signal.throwIfAborted();if(created)throw new AppError(409,'本轮已创建文档。');
          const content=fromHTML(html);if(validateContent(content).textContent.length<10)throw new AppError(400,'文档内容过短。');
          created=store.tx(()=>{const n=store.create(title,content);chats.link(id,n.id);return n;});
          send('created',{note:created});return {id:created.id,title:created.title,saved:true};
        }},
      });
      const reply=result.text.trim()||(created?`已创建文档《${created.title}》。`:'');
      if(reply){chats.add(id,'assistant',reply);recorded=true;}
      send('done',{chat:chats.get(id),...(created?{note:created}:{})});
    } catch(error) {
      if(!recorded&&(partial.trim()||created))chats.add(id,'assistant',`${partial.trim()}${created?`\n已保存文档《${created.title}》。`:''}\n[本次回复中断]`.trim());
      send('error',{message:error instanceof Error?error.message:'模型请求失败。'});
      send('done',{chat:chats.get(id),...(created?{note:created}:{})});
    } finally {clearInterval(heartbeat);busy.delete(id);res.end();}
  });
  return chats;
}
