import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createAIService } from '../server/ai.ts';
import { createApp } from '../server/app.ts';
import type { AIRunOptions } from '../server/ai-types.ts';
import { validateContent } from '../server/documents.ts';

// Explicit dependency-injected fixture. This proves orchestration, NOT real model inference.
test('fixture集成：讨论上下文、一次写回、撤销、冲突和失败回滚',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'study-flow-'));const ai=await createAIService(dir);
 const status=ai.status.bind(ai);ai.status=()=>({...status(),ready:true});let captured:AIRunOptions[]=[];
 ai.run=async options=>{
  captured.push(options);let text='';
  if(options.mode==='create')await options.tools!.createDocument!({title:'合成验收文章',html:'<h2>检索</h2><p>语义检索理解意思。</p><p>未选择的正文。</p>'});
  else if(options.mode==='revise'||options.mode==='writeback')await options.tools!.proposeEdit!({replacement:'<p>语义检索通过向量比较含义的接近程度。</p>',explanation:'加入原理'});
  else{text='这是fixture回答，仅用于验证上下文。';await options.onEvent?.({type:'delta',text});}
  return {text,model:'fixture',provider:'openai'};
 };
 const {app,store}=await createApp(dir,{ai});const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
  const {token}=await(await fetch(base+'/api/session')).json() as any;
  const call=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-study-token':token},body:JSON.stringify(body)});
  const events=async(r:Response)=>{assert.equal(r.status,200);return (await r.text()).split('\n\n').filter(s=>s.includes('data: ')).map(s=>({type:s.match(/event: (.*)/)![1],data:JSON.parse(s.match(/data: (.*)/)![1])}));};
  const generated=await events(await call('/api/notes/generate',{prompt:'请写一篇检索文章'}));let n=generated.find(e=>e.type==='done')!.data.note;
  let from=0;validateContent(n.content).descendants((node,pos)=>{if(node.isText&&node.text==='语义检索理解意思。')from=pos;});
  let r=await call(`/api/notes/${n.id}/threads`,{revision:n.revision,from,to:from+9,quote:'语义检索理解意思。'});assert.equal(r.status,201);let a=await r.json() as any;n=a.note;
  const path=`/api/notes/${n.id}/threads/${a.threadId}/message`;
  await events(await call(path,{text:'什么是向量？',mode:'chat'}));await events(await call(path,{text:'用刚才的概念再举例。',mode:'chat'}));
  assert.equal(captured.at(-1)!.tools?.proposeEdit,undefined);
  const last=captured.at(-1)!;assert.equal(last.messages.length,3);assert.equal(last.messages[0].content,'什么是向量？');assert.equal(last.messages[1].role,'assistant');assert.equal(last.context!.selection!.text,'语义检索理解意思。');
  const revised=await events(await call(path,{text:'把解释补进去',mode:'revise'}));const p=revised.find(e=>e.type==='proposal')!.data;
  const before=store.get(n.id);assert.ok(validateContent(before.content).textContent.includes('语义检索理解意思。'));
  r=await call(`/api/notes/${n.id}/proposals/${p.id}/apply`,{revision:before.revision});assert.equal(r.status,200);n=await r.json();
  assert.ok(validateContent(n.content).textContent.includes('未选择的正文。'));assert.ok(validateContent(n.content).textContent.includes('通过向量'));
  r=await call(`/api/notes/${n.id}/undo`,{revision:n.revision,proposalId:p.id});assert.equal(r.status,200);n=await r.json();
  const direct=await events(await call(path,{text:'将讨论融入正文，直接保存',mode:'writeback'}));
  assert.ok(!direct.some(e=>e.type==='error'));
  n=direct.find(e=>e.type==='done')!.data.note;
  const written=n.threads[0].proposals.at(-1);
  assert.equal(written.state,'applied');assert.ok(validateContent(n.content).textContent.includes('通过向量'));
  assert.ok(validateContent(n.content).textContent.includes('未选择的正文。'));
  r=await call(`/api/notes/${n.id}/undo`,{revision:n.revision,proposalId:written.id});assert.equal(r.status,200);n=await r.json();
  assert.ok(validateContent(n.content).textContent.includes('语义检索理解意思。'));
  assert.equal(n.threads[0].proposals.at(-1).state,'undone');
  const oldRevision=n.revision;
  store.save(n.id,n.revision,'并发保存',n.content);
  assert.throws(()=>store.writeback(n.id,a.threadId,oldRevision,'语义检索理解意思。','<p>不可覆盖</p>','过期请求'),/已更新/);
  assert.equal(store.get(n.id).threads[0].proposals.length,2);
  // An invalid marked replacement must roll back both proposal and document.
  const latest=store.get(n.id);
  assert.throws(()=>store.writeback(n.id,a.threadId,latest.revision,'语义检索理解意思。','<hr>','测试失败回滚'),/定位/);
  assert.equal(store.get(n.id).revision,latest.revision);
  assert.equal(store.get(n.id).threads[0].proposals.length,2);
  assert.equal(n.threads[0].proposals[0].state,'undone');assert.equal(n.threads[0].messages.filter((m:any)=>m.role==='user').length,4);
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
