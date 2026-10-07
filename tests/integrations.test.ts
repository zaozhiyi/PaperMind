import { FakeGithub } from './helpers/github.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DocumentStore, fromHTML, validateContent } from '../server/documents.ts';
import { createIntegrationService, extractArticle, exportMarkdown, isPublicAddress, validateImportURL, validateDestination, type GithubClient } from '../server/integrations.ts';

const sha=(text:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'study-integrations-'));const store=new DocumentStore(dir,false);const github=new FakeGithub();const service=await createIntegrationService(store,dir,{github,fetchPage:async url=>({url,html:'<html><title>学习副本</title><main><h1>公开文章</h1><div data-content-ref-root><h2>第一节</h2><p>这是一段用于测试导入功能的公开文章内容。</p></div></main></html>'})});return {dir,store,github,service,close:async()=>{store.close();await rm(dir,{recursive:true,force:true});}};}

test('SSRF: URL及公网地址校验拒绝本机、内网、保留地址和危险协议',()=>{
 for(const url of ['http://example.com','https://localhost/x','https://127.0.0.1','https://[::1]','https://foo.internal','https://foo.local','https://user:pass@example.com','https://example.com:8443','file:///etc/passwd','https://2130706433'])assert.throws(()=>validateImportURL(url));
 for(const ip of ['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','198.18.0.3','224.0.0.1','::1','fe80::1','fc00::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::'])assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['1.1.1.1','104.18.40.47','2606:4700:4700::1111'])assert.equal(isPublicAddress(ip),true,ip);
 assert.equal(validateImportURL('https://example.com/page#section').href,'https://example.com/page');
});

test('正文提取保留标题、表格、代码与链接，排除导航脚本并把媒体转为链接',()=>{
 const result=extractArticle({url:'https://example.com/docs/one',html:'<html><title>备用标题</title><nav>污染导航</nav><main><h1>文章标题</h1><div data-content-ref-root><h2>章节</h2><p onclick="x()">学习正文<a href="../two">其他文章</a><a href="javascript:x()">坏链接</a></p><table><tr><th>名称</th><th>解释</th></tr><tr><td>概念</td><td>示例</td></tr></table><pre><code>const value = 1 &lt; 2;</code></pre><iframe src="https://video.example.com/embed"></iframe><img src="https://example.com/image.png" alt="例图"><script>恶意内容</script></div></main></html>'});
 assert.equal(result.title,'文章标题');assert.match(result.html,/<table(?:\s|>)/);assert.ok(result.html.includes('<pre><code>'));assert.ok(result.html.includes('href="https://example.com/two"'));assert.ok(!/onclick|javascript:|iframe|<img|恶意内容|污染导航/.test(result.html));assert.equal(result.warnings.length,3);
});

test('导入必须经过预览，重复确认幂等且保留来源，修改副本不影响原网页',async()=>{
 const f=await fixture();try{assert.throws(()=>f.service.importNote('unknown'),/过期/);const p=await f.service.importPreview('https://example.com/book');assert.equal(f.store.list().length,0);const {note}=f.service.importNote(p.previewId);assert.equal(note.sourceUrl,'https://example.com/book');assert.equal(f.service.importNote(p.previewId).note.id,note.id);assert.equal(f.store.list().length,1);assert.ok(validateContent(note.content).textContent.includes('用于测试'));}finally{await f.close();}
});

test('Markdown导出保留代码围栏、标题、列表、表格和来源',async()=>{
 const f=await fixture();try{const note=f.store.create('导出测试',fromHTML('<h2>章节</h2><p><strong>粗体</strong>与<a href="https://example.com">来源</a></p><ul><li><p>项目</p></li></ul><pre><code>const s = "```";</code></pre><table><tr><th>名</th><th>值</th></tr><tr><td>A</td><td>B</td></tr></table>'),'https://source.example.com/page');const md=exportMarkdown(note);assert.ok(md.includes('## 章节'));assert.ok(md.includes('**粗体**'));assert.ok(md.includes('- 项目'));assert.ok(md.includes('````'));assert.ok(md.includes('| 名 | 值 |'));assert.ok(md.includes('来源：[原文](https://source.example.com/page)'));}finally{await f.close();}
});

test('GitHub：只读预览指定文档的三文件，确认后非强制提交，重复确认幂等',async()=>{
 const f=await fixture();try{
 const note=f.store.create('第一篇',fromHTML('<p>这是当前文章。</p>'));f.store.create('不应同步',fromHTML('<p>私有其他文档。</p>'));
 const p=await f.service.syncPreview({repo:'owner/repo',noteIds:[note.id]});assert.equal(p.files.length,3);assert.ok(p.files.every(file=>file.path.includes(note.id)));assert.ok(!p.files.some(file=>file.content.includes('私有其他')));assert.ok(f.github.calls.every(call=>call.method==='GET'));assert.ok(p.files.some(file=>file.path.endsWith('comments.json')));
 const pushed:any=await f.service.push(p.previewId);assert.equal(pushed.files,3);assert.equal(f.github.files.size,3);const calls=f.github.calls.length;assert.deepEqual(await f.service.push(p.previewId),pushed);assert.equal(f.github.calls.length,calls);
 const second=await f.service.syncPreview({repo:'owner/repo',noteIds:[note.id]});assert.ok(second.files.every(file=>file.status==='unchanged'));
 }finally{await f.close();}
});

test('GitHub：首次不覆盖未知文件；已登记文件被远端改动也拒绝覆盖',async()=>{
 const f=await fixture();try{
 const note=f.store.create('冲突',fromHTML('<p>正文</p>'));const path=`learning-notes/${note.id}/README.md`;f.github.files.set(path,'不是本应用创建的文件');
 await assert.rejects(f.service.syncPreview({repo:'owner/repo',noteIds:[note.id]}),/未由本应用登记/);assert.ok(f.github.calls.every(c=>c.method==='GET'));
 f.github.files.clear();const p=await f.service.syncPreview({repo:'owner/repo',noteIds:[note.id]});await f.service.push(p.previewId);f.github.files.set(path,'他人修改');await assert.rejects(f.service.syncPreview({repo:'owner/repo',noteIds:[note.id]}),/已被其他人修改/);
 }finally{await f.close();}
});

test('GitHub：预览后本地或远端变动必须重新预览，无写请求',async()=>{
 for(const change of ['local','remote']){const f=await fixture();try{
 const note=f.store.create('快照',fromHTML('<p>原始文档</p>'));const p=await f.service.syncPreview({repo:'owner/repo',noteIds:[note.id]});
 if(change==='local')f.store.save(note.id,note.revision,note.title,fromHTML('<p>用户后续编辑</p>'));else f.github.head='head-2';
 await assert.rejects(f.service.push(p.previewId),/预览/);assert.ok(f.github.calls.every(c=>c.method==='GET'));
 }finally{await f.close();}}
});

test('GitHub：并发远端提交使非快进写入失败，不force覆盖',async()=>{
 const f=await fixture();try{const note=f.store.create('并发',fromHTML('<p>文档</p>'));const p=await f.service.syncPreview({repo:'owner/repo',noteIds:[note.id]});f.github.advanceDuringPush=true;await assert.rejects(f.service.push(p.previewId),/non-fast-forward/);assert.equal(f.github.head,'concurrent-commit');assert.equal(f.github.files.size,0);assert.equal(f.github.calls.find(c=>c.method==='PATCH')?.body.force,false);}finally{await f.close();}
});

test('GitHub：路径与分支校验阻止越界与危险目录',()=>{
 for(const folder of ['../other','.github/workflows','a/../../b','/absolute','safe//double','a/./b','a\\b','safe/'])assert.throws(()=>validateDestination({repo:'owner/repo',folder}));
 for(const branch of ['../main','main..next','refs//branch','a.lock','a/.hidden','-bad'])assert.throws(()=>validateDestination({repo:'owner/repo',branch}));
 for(const repo of ['owner/repo/other','-bad/repo','owner/..','https://github.com/owner/repo'])assert.throws(()=>validateDestination({repo}));
 assert.equal(validateDestination({repo:'owner/repo',branch:'notes/main',folder:'docs/learning'}).folder,'docs/learning');
});

test('GitHub：同步登记在服务重开后保留，更新预览同时展示远端原文和本次正文',async()=>{
 const f=await fixture();try{
 let note=f.store.create('可继续同步',fromHTML('<p>第一版正文</p>'));const first=await f.service.syncPreview({repo:'owner/repo',noteIds:[note.id]});await f.service.push(first.previewId);
 note=f.store.save(note.id,note.revision,note.title,fromHTML('<p>第二版正文</p>'));
 const restored=await createIntegrationService(f.store,f.dir,{github:f.github});const preview=await restored.syncPreview({repo:'owner/repo',noteIds:[note.id]});const readme=preview.files.find(file=>file.path.endsWith('README.md'))!;
 assert.equal(readme.status,'update');assert.ok(readme.previousContent?.includes('第一版正文'));assert.ok(readme.content.includes('第二版正文'));assert.equal(preview.files.find(file=>file.path.endsWith('comments.json'))!.status,'unchanged');
 const result:any=await restored.push(preview.previewId);assert.equal(result.files,2);assert.ok(f.github.files.get(readme.path)?.includes('第二版正文'));
 }finally{await f.close();}
});

test('双向同步：两台机器恢复正文与讨论、推回、冲突保留副本及重新打开',async()=>{
 const f=await fixture();const dirB=await mkdtemp(join(tmpdir(),'yejian-machine-b-'));let b=new DocumentStore(dirB,false);
 try{
 let original=f.store.create('两台电脑',fromHTML('<h2>章节</h2><p><mark data-color="#fff0a8">学习资料</mark>需要讨论。</p>'));let from=0;validateContent(original.content).descendants((n,pos)=>{if(n.text==='学习资料')from=pos;});const anchored=f.store.addThread(original.id,original.revision,from,from+4,'学习资料');original=anchored.note;f.store.addMessage(original.id,anchored.threadId,'user','保留这段讨论');
 const uploaded=await f.service.syncPreview({repo:'owner/repo',noteIds:[original.id]});await f.service.push(uploaded.previewId);
 let serviceB=await createIntegrationService(b,dirB,{github:f.github});let preview=await serviceB.pullPreview({repo:'owner/repo',folder:'learning-notes'});assert.equal(preview.items[0].status,'add');
 const pulled=await serviceB.pull(preview.previewId);assert.equal(pulled.notes[0].id,original.id);assert.deepEqual(pulled.notes[0].content,f.store.get(original.id).content);assert.equal(pulled.notes[0].threads[0].messages[0].text,'保留这段讨论');assert.equal(pulled.notes[0].threads[0].detached,false);assert.deepEqual(await serviceB.pull(preview.previewId),pulled);
 let local=b.get(original.id);b.save(local.id,local.revision,'B 的标题',local.content);const update=await serviceB.syncPreview({repo:'owner/repo',noteIds:[local.id]});await serviceB.push(update.previewId);
 let incoming=await f.service.pullPreview({repo:'owner/repo',folder:'learning-notes'});assert.equal(incoming.items[0].status,'update');await f.service.pull(incoming.previewId);assert.equal(f.store.get(local.id).title,'B 的标题');
 local=b.get(local.id);b.save(local.id,local.revision,'B 的第二次修改',local.content);await serviceB.push((await serviceB.syncPreview({repo:'owner/repo',noteIds:[local.id]})).previewId);
 const a=f.store.get(local.id);f.store.save(a.id,a.revision,'A 离线修改',a.content);f.store.addMessage(a.id,a.threads[0].id,'assistant','A 新增的讨论不会丢');
 incoming=await f.service.pullPreview({repo:'owner/repo',folder:'learning-notes'});assert.equal(incoming.items[0].status,'conflict');const merge=await f.service.pull(incoming.previewId);assert.equal(merge.backups.length,1);assert.equal(merge.notes[0].title,'B 的第二次修改');assert.match(merge.backups[0].title,/A 离线修改/);assert.ok(merge.backups[0].threads[0].messages.some(m=>m.text==='A 新增的讨论不会丢'));assert.notEqual(merge.backups[0].threads[0].id,merge.notes[0].threads[0].id);assert.equal(merge.backups[0].threads[0].detached,false);
 assert.equal((await f.service.pullPreview({repo:'owner/repo',folder:'learning-notes'})).items[0].status,'unchanged');
 b.close();b=new DocumentStore(dirB,false);serviceB=await createIntegrationService(b,dirB,{github:f.github});assert.equal((await serviceB.pullPreview({repo:'owner/repo',folder:'learning-notes'})).items[0].status,'unchanged');
 // Local-only edits are never rolled back by repeatedly pulling unchanged remote files.
 local=b.get(local.id);b.save(local.id,local.revision,'仅本机继续编辑',local.content);preview=await serviceB.pullPreview({repo:'owner/repo',folder:'learning-notes'});assert.equal(preview.items[0].status,'local');await serviceB.pull(preview.previewId);assert.equal(b.get(local.id).title,'仅本机继续编辑');
 }finally{b.close();await rm(dirB,{recursive:true,force:true});await f.close();}
});

test('拉取：外部Markdown修改重新定位讨论；预览后讨论或远端变化会拒绝恢复',async()=>{
 const f=await fixture();try{
 let note=f.store.create('外部编辑',fromHTML('<p>不变的原文。</p><p>随后修改这里。</p>'));const t=f.store.addThread(note.id,note.revision,1,7,'不变的原文。');note=t.note;
 await f.service.push((await f.service.syncPreview({repo:'owner/repo',noteIds:[note.id]})).previewId);
 const path=`learning-notes/${note.id}/README.md`,text='# 外部编辑\n\n不变的原文。\n\nGitBook 中补充的解释。\n';f.github.files.set(path,text);f.github.blobs.set(sha(text),text);f.github.head='remote-markdown-2';
 let p=await f.service.pullPreview({repo:'owner/repo',folder:'learning-notes'});assert.equal(p.items[0].status,'update');assert.ok(p.items[0].warnings.length);
 f.store.addMessage(note.id,t.threadId,'user','预览期间的新问题');await assert.rejects(f.service.pull(p.previewId),/本机正文或讨论/);
 p=await f.service.pullPreview({repo:'owner/repo',folder:'learning-notes'});assert.equal(p.items[0].status,'conflict');f.github.head='new-remote-head';await assert.rejects(f.service.pull(p.previewId),/远端/);
 p=await f.service.pullPreview({repo:'owner/repo',folder:'learning-notes'});const restored=await f.service.pull(p.previewId);assert.ok(validateContent(restored.notes[0].content).textContent.includes('GitBook'));assert.equal(restored.notes[0].threads[0].detached,false);assert.equal(restored.backups[0].threads[0].messages[0].text,'预览期间的新问题');
 }finally{await f.close();}
});

test('拉取：损坏的讨论文件拒绝；多篇恢复中途失败整体回滚',async()=>{
 const f=await fixture();const dir=await mkdtemp(join(tmpdir(),'yejian-pull-rollback-'));const b=new DocumentStore(dir,false);
 try{
 const one=f.store.create('文档一',fromHTML('<p>第一篇完整正文</p>'));const two=f.store.create('文档二',fromHTML('<p>第二篇完整正文</p>'));await f.service.push((await f.service.syncPreview({repo:'owner/repo',noteIds:[one.id,two.id]})).previewId);
 const svc=await createIntegrationService(b,dir,{github:f.github});const p=await svc.pullPreview({repo:'owner/repo',folder:'learning-notes'});const restore=b.restoreBundle.bind(b);let calls=0;b.restoreBundle=(...args)=>{if(++calls===2)throw new Error('模拟存储失败');return restore(...args);};await assert.rejects(svc.pull(p.previewId),/模拟存储失败/);assert.equal(b.list().length,0);b.restoreBundle=restore;assert.equal((await svc.pull(p.previewId)).notes.length,2);
 const path=`learning-notes/${one.id}/comments.json`;const text=JSON.stringify({format:'yejian-discussions-v1',noteId:two.id,threads:[]});f.github.files.set(path,text);f.github.blobs.set(sha(text),text);await assert.rejects(svc.pullPreview({repo:'owner/repo',folder:'learning-notes'}),/格式无效/);assert.equal(b.list().length,2);
 }finally{b.close();await rm(dir,{recursive:true,force:true});await f.close();}
});
