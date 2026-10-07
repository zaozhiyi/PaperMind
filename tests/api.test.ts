import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../server/app.ts';

test('真实HTTP：同源会话保护、版本冲突、无模型拒绝、数据恢复',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'study-api-'));let {app,store}=await createApp(dir);let server=createServer(app);
 const start=async()=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as any).port}`;};
 let base=await start();
 try{
  let {token}=await(await fetch(base+'/api/session')).json() as any;
  const call=(path:string,body:unknown,headers:Record<string,string>={},method='POST')=>fetch(base+path,{method,headers:{'content-type':'application/json','x-study-token':token,...headers},body:JSON.stringify(body)});
  assert.equal((await call('/api/notes',{title:'拒绝外站'},{origin:'https://evil.invalid'})).status,403);
  assert.equal((await call('/api/notes',{title:'拒绝无会话'},{'x-study-token':''})).status,403);
  const r=await call('/api/notes',{title:'HTTP持久化验证'});assert.equal(r.status,201);let n=await r.json() as any;
  const payload={revision:n.revision,title:n.title,content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'保存的中文内容'}]}]}};
  const saves=await Promise.all([call(`/api/notes/${n.id}`,payload,{},'PUT'),call(`/api/notes/${n.id}`,payload,{},'PUT')]);
  assert.deepEqual(saves.map(s=>s.status).sort(),[200,409]);
  const generation=await call('/api/notes/generate',{prompt:'生成文档'});assert.equal(generation.status,409);assert.match((await generation.json() as any).message,/连接|登录/);
  const thread=await call(`/api/notes/${n.id}/threads`,{revision:2,from:1,to:4,quote:'保存的'});assert.equal(thread.status,201);
  n=(await thread.json() as any).note;
  const current=await(await fetch(base+`/api/notes/${n.id}`)).json();assert.deepEqual(current,n);
  await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));store.close();
  ({app,store}=await createApp(dir));server=createServer(app);base=await start();
  assert.deepEqual(await(await fetch(base+`/api/notes/${n.id}`)).json(),n);
  assert.equal((await call('/api/notes',{title:'旧会话应失效'})).status,403);
  ({token}=await(await fetch(base+'/api/session')).json() as any);
  assert.equal((await call('/api/ai/model',{model:'不存在的模型'})).status,400);
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
