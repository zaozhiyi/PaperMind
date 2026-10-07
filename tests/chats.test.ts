import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../server/app.ts';
import { createAIService } from '../server/ai.ts';
import { DocumentStore } from '../server/documents.ts';
import { ChatStore } from '../server/chats.ts';
import type { AIRunOptions } from '../server/ai-types.ts';

// A fixture tests HTTP orchestration and persistence, not actual model reasoning.
test('主聊天：问答不建文档；随后按讨论创建并关联文档；故障后已创建的文档仍保留',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'yejian-chat-')),ai=await createAIService(dir),status=ai.status.bind(ai);
 ai.status=()=>({...status(),ready:true});const calls:AIRunOptions[]=[];
 ai.run=async options=>{calls.push(options);assert.equal(options.mode,'workspace');const q=options.messages.at(-1)!.content;
  if(q.includes('整理')){await options.tools!.createDocument!({title:'检索笔记',html:'<p>这是依据前文讨论整理的合成笔记。</p>'});if(q.includes('中断'))throw new Error('合成网络中断');return {text:'',provider:'openai',model:'fixture'};}
  await options.onEvent?.({type:'delta',text:'这是合成讨论回答。'});return {text:'这是合成讨论回答。',provider:'openai',model:'fixture'};
 };
 const {app,store}=await createApp(dir,{ai}),server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const {token}=await(await fetch(base+'/api/session')).json() as any;
  const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-study-token':token},body:JSON.stringify(body)});
  const parse=async(r:Response)=>{assert.equal(r.status,200);return(await r.text()).split('\n\n').filter(x=>x.includes('data:')).map(x=>({type:x.match(/event: (.+)/)![1],data:JSON.parse(x.match(/data: (.+)/)![1])}));};
  const c=await(await post('/api/chats',{})).json() as any;const initial=store.list().length;
  let es=await parse(await post(`/api/chats/${c.id}/message`,{text:'先讨论，为什么需要检索？'}));assert.equal(store.list().length,initial);assert.equal(es.at(-1)!.data.chat.messages.length,2);
  es=await parse(await post(`/api/chats/${c.id}/message`,{text:'把刚才讨论整理成文档'}));assert.equal(calls[1].messages.length,3);const n=es.find(e=>e.type==='created')!.data.note;assert.ok(es.at(-1)!.data.chat.noteIds.includes(n.id));assert.equal(store.list().length,initial+1);
  es=await parse(await post(`/api/chats/${c.id}/message`,{text:'继续解释这个文档',noteId:n.id}));assert.equal(calls[2].context?.document?.id,n.id);
  es=await parse(await post(`/api/chats/${c.id}/message`,{text:'整理另一份（合成中断）'}));assert.equal(calls[3].context?.document,undefined);assert.ok(es.some(e=>e.type==='error'));assert.ok(es.at(-1)!.data.note);assert.equal(es.at(-1)!.data.chat.noteIds.length,2);
  const current=new ChatStore(store).get(c.id);store.close();const reopened=new DocumentStore(dir,false);try{assert.deepEqual(new ChatStore(reopened).get(c.id),current);}finally{reopened.close();}
 }finally{await new Promise<void>(r=>server.close(()=>r()));try{store.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});

test('文章讨论：稳定绑定、跨文档隔离、刷新与重启保留上下文',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'yejian-doc-chat-')),ai=await createAIService(dir),status=ai.status.bind(ai);
 ai.status=()=>({...status(),ready:true});const calls:AIRunOptions[]=[];
 ai.run=async options=>{calls.push(options);assert.equal(options.mode,'chat');assert.equal(options.tools?.createDocument,undefined);return {text:'合成文章回答',provider:'openai',model:'fixture'};};
 const {app,store}=await createApp(dir,{ai}),server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const {token}=await(await fetch(base+'/api/session')).json() as any;
  const post=(path:string,body:unknown={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-study-token':token},body:JSON.stringify(body)});
  const a=store.create('文章甲'),b=store.create('文章乙'),chats=new ChatStore(store),initial=chats.list().length;
  assert.equal(await(await fetch(`${base}/api/notes/${a.id}/chat`)).json(),null);assert.equal(chats.list().length,initial);
  const ca=await(await post(`/api/notes/${a.id}/chat`)).json() as any;
  const again=await(await post(`/api/notes/${a.id}/chat`)).json() as any;
  const cb=await(await post(`/api/notes/${b.id}/chat`)).json() as any;
  assert.equal(ca.id,again.id);assert.equal(ca.documentId,a.id);assert.notEqual(ca.id,cb.id);
  const mismatch=await post(`/api/chats/${ca.id}/message`,{text:'错误的上下文',noteId:b.id});assert.equal(mismatch.status,409);assert.equal(chats.get(ca.id).messages.length,0);assert.equal(calls.length,0);
  let response=await post(`/api/chats/${ca.id}/message`,{text:'解释当前文章'});assert.equal(response.status,200);await response.text();
  assert.equal(calls[0].context?.document?.id,a.id);assert.equal(chats.get(cb.id).messages.length,0);
  response=await post(`/api/chats/${ca.id}/message`,{text:'继续刚才的讨论'});await response.text();assert.equal(calls[1].messages.length,3);
  const persisted=await(await fetch(`${base}/api/notes/${a.id}/chat`)).json() as any;assert.equal(persisted.messages.length,4);
  store.close();const reopened=new DocumentStore(dir,false);try{assert.deepEqual(JSON.parse(JSON.stringify(new ChatStore(reopened).forDocument(a.id))),persisted);}finally{reopened.close();}
 }finally{await new Promise<void>(r=>server.close(()=>r()));try{store.close();}catch{}rmSync(dir,{recursive:true,force:true});}
});
