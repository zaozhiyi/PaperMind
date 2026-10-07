import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DocumentStore,fromHTML} from '../server/documents.ts';
import {ChatStore} from '../server/chats.ts';
import {createIntegrationService} from '../server/integrations.ts';
import {assertPrivateOwner,createKnowledgeSync} from '../server/knowledge-sync.ts';
import {FakeGithub} from './helpers/github.ts';
class PrivateGithub extends FakeGithub {
 privateRepo=true;collaborators:any[]=[];invitations:any[]=[];
 async request<T=any>(method:string,path:string,body?:any):Promise<T>{
  if(method==='GET'&&path==='repos/owner/repo')return {default_branch:'main',private:this.privateRepo,visibility:this.privateRepo?'private':'public',permissions:{push:true,admin:true},owner:{type:'User',login:'fixture-user'}} as T;
  if(path.includes('/collaborators'))return this.collaborators as T;
  if(path.includes('/invitations'))return this.invitations as T;
  return super.request(method,path,body);
 }
}
test('自动同步拒绝公开仓库、协作者、邀请；隐私变更后没有写入',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'knowledge-'));const store=new DocumentStore(dir,false);const g=new PrivateGithub();
 try{
 const service=await createIntegrationService(store,dir,{github:g});const sync=createKnowledgeSync(store,service,g);store.create('笔记',fromHTML('<p>测试正文</p>'));
 await sync.configure({repo:'owner/repo',branch:'main',folder:'notes',enabled:true,excludedIds:[]});
 g.privateRepo=false;await assert.rejects(sync.sync(),/私有仓库/);assert.equal(g.calls.filter(c=>c.method!=='GET').length,0);
 g.privateRepo=true;g.collaborators=[{login:'someone'}];await assert.rejects(assertPrivateOwner(g,'owner/repo'),/协作者/);
 g.collaborators=[];g.invitations=[{}];await assert.rejects(assertPrivateOwner(g,'owner/repo'),/邀请/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('整篇对话随正文往返，新电脑恢复；自动同步无改动不写入，配置重启保留',async()=>{
 const a=await mkdtemp(join(tmpdir(),'knowledge-a-')),b=await mkdtemp(join(tmpdir(),'knowledge-b-'));const sa=new DocumentStore(a,false),sb=new DocumentStore(b,false),g=new PrivateGithub();
 try{
 const note=sa.create('课堂',fromHTML('<p>学习正文</p>'));const chats=new ChatStore(sa),chat=chats.forDocument(note.id,true)!;chats.add(chat.id,'user','如何理解？');chats.add(chat.id,'assistant','解释如下。');
 const service=await createIntegrationService(sa,a,{github:g});const sync=createKnowledgeSync(sa,service,g);
 await sync.configure({repo:'owner/repo',branch:'main',folder:'notes',enabled:true,excludedIds:[]});await sync.sync();
 const writes=g.calls.filter(c=>c.method!=='GET').length;await sync.sync();assert.equal(g.calls.filter(c=>c.method!=='GET').length,writes);
 const other=await createIntegrationService(sb,b,{github:g});await other.pull((await other.pullPreview({repo:'owner/repo',folder:'notes'})).previewId);
 assert.deepEqual(new ChatStore(sb).forDocument(note.id)?.messages,chats.get(chat.id).messages);
 const newMachine=createKnowledgeSync(sb,other,g);await newMachine.configure({repo:'owner/repo',branch:'main',folder:'notes',enabled:true,excludedIds:[]});await newMachine.sync();assert.equal(g.calls.filter(c=>c.method!=='GET').length,writes,'restoring must not cause metadata ping-pong');
 const restored=createKnowledgeSync(sa,service,g);assert.equal(restored.status().config?.repo,'owner/repo');
 const before=sa.get(note.id);const copy=sa.tx(()=>sa.restoreBundle(before,true));assert.equal(copy.documentMessages?.length,2);assert.notEqual(copy.documentMessages?.[0].id,before.documentMessages?.[0].id);
 }finally{sa.close();sb.close();await rm(a,{recursive:true,force:true});await rm(b,{recursive:true,force:true});}
});
test('推送前再次检查权限：预览后转为公开也不上传 blob',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'knowledge-guard-'));const store=new DocumentStore(dir,false),g=new PrivateGithub();
 try{const note=store.create('私有内容',fromHTML('<p>不可公开</p>'));const service=await createIntegrationService(store,dir,{github:g,beforePush:repo=>assertPrivateOwner(g,repo).then(()=>{})});
 const preview=await service.syncPreview({repo:'owner/repo',noteIds:[note.id]});g.privateRepo=false;await assert.rejects(service.push(preview.previewId),/私有仓库/);assert.equal(g.calls.filter(c=>c.method!=='GET').length,0);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('自动同步有冲突时保留本机，暂停本轮写入并显示错误',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'knowledge-conflict-'));const store=new DocumentStore(dir,false),g=new PrivateGithub();
 try{const n=store.create('课程',fromHTML('<p>本机新内容</p>'));let wrote=false;
 const service={pullPreview:async()=>({items:[{id:n.id,status:'conflict'}]}),pull:async()=>{wrote=true;},syncPreview:async()=>{wrote=true;}} as any;
 const sync=createKnowledgeSync(store,service,g);await sync.configure({repo:'owner/repo',branch:'main',folder:'notes',enabled:true,excludedIds:[]});await assert.rejects(sync.sync(),/同时修改/);assert.equal(wrote,false);assert.equal(store.get(n.id).revision,n.revision);assert.match(sync.status().error||'',/同时修改/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('跨文章粘贴保留正文，移除另一篇文章的批注引用',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'knowledge-paste-'));const store=new DocumentStore(dir,false);
 try{const a=store.create('甲',fromHTML('<p>相同文字</p>')),b=store.create('乙',fromHTML('<p>另一段</p>'));const thread=store.addThread(a.id,a.revision,1,5,'相同文字');store.addMessage(a.id,thread.threadId,'user','原始讨论');
 const saved=store.save(b.id,b.revision,b.title,thread.note.content);assert.equal(saved.content.content?.[0].content?.[0].text,'相同文字');assert.equal(saved.threads.length,0);assert.ok(!JSON.stringify(saved.content).includes(thread.threadId));assert.equal(store.get(a.id).threads[0].messages.length,1);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
