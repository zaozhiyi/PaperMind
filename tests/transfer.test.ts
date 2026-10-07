import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { validateContent } from '../server/documents.ts';

test('真实CLI交付：幂等创建、读取、版本更新、锚点恢复与过期拒绝',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'yejian-transfer-'));const {app,store}=await createApp(dir);const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 const cli=(args:string[])=>new Promise<{error:any;out:string;err:string}>(resolve=>execFile(process.execPath,[fileURLToPath(new URL('../bin/yejian.mjs',import.meta.url)),'notes',...args,'--port',String(port)],{timeout:10000},(error,out,err)=>resolve({error,out,err})));
 try{
 const file=join(dir,'note.md');await writeFile(file,'# 检索入门\n\n## 第一章\n\n检索找到需要的资料。\n\n保留的末段。');
 let r=await cli(['import',file]);assert.equal(r.error,null,r.err);let n=JSON.parse(r.out);const id=n.id;assert.equal(n.created,true);assert.ok(n.url.includes('?note='+id));
 r=await cli(['import',file]);assert.equal(JSON.parse(r.out).id,id);assert.equal(JSON.parse(r.out).created,false);
 r=await cli(['get',id]);assert.equal(JSON.parse(r.out).title,'检索入门');
 let note=store.get(id);let from=0;validateContent(note.content).descendants((node,pos)=>{if(node.text==='检索找到需要的资料。')from=pos;});const t=store.addThread(id,note.revision,from,from+11,'检索找到需要的资料。');store.addMessage(id,t.threadId,'user','这句怎么理解？');
 await writeFile(file,'# 检索入门\n\n## 新的引言\n\n新增内容。\n\n检索找到需要的资料。\n\n保留的末段。');
 r=await cli(['import',file]);assert.ok(r.error);assert.match(r.err,/revision/);
 r=await cli(['import',file,'--id',id,'--revision',String(t.note.revision)]);assert.equal(r.error,null,r.err);n=JSON.parse(r.out);note=store.get(id);assert.equal(note.threads[0].detached,false);assert.equal(note.threads[0].messages[0].text,'这句怎么理解？');
 await writeFile(file,'# 检索入门\n\n同一句出现两次：\n\n检索找到需要的资料。\n\n检索找到需要的资料。');
 r=await cli(['import',file,'--id',id,'--revision',String(t.note.revision)]);assert.ok(r.error);assert.match(r.err,/已更新/);
 r=await cli(['import',file,'--id',id,'--revision',String(n.revision)]);assert.equal(r.error,null,r.err);assert.ok(JSON.parse(r.out).warnings.length);assert.equal(store.get(id).threads[0].detached,true);
 const {token}=await(await fetch(`http://127.0.0.1:${port}/api/session`)).json() as any;
 const invalid=await fetch(`http://127.0.0.1:${port}/api/agent/documents`,{method:'POST',headers:{'content-type':'application/json','x-study-token':token},body:JSON.stringify({format:'html',body:'<script>alert(1)</script>'})});assert.equal(invalid.status,400);
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();await rm(dir,{recursive:true,force:true});}
});

test('外部全文更新保留唯一原文的高亮，重复文字不猜测位置',async()=>{
 const {DocumentStore,fromHTML,preserveDiscussionAnchors,toHTML}=await import('../server/documents.ts');const dir=await mkdtemp(join(tmpdir(),'yejian-highlights-'));const store=new DocumentStore(dir,false);
 try{const old=store.create('高亮保留',fromHTML('<p><mark data-color="#fff0a8">缓存命中</mark>有帮助。</p>'));
 assert.match(toHTML(preserveDiscussionAnchors(old,fromHTML('<p>新引言。</p><p>缓存命中有帮助。</p>'))),/<mark[^>]*>缓存命中<\/mark>/);
 assert.doesNotMatch(toHTML(preserveDiscussionAnchors(old,fromHTML('<p>缓存命中</p><p>缓存命中</p>'))),/<mark/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
