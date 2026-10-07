import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentStore, fromHTML, toHTML, validateContent, threadRange } from '../server/documents.ts';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'study-test-'));const store=new DocumentStore(dir,false);return {store,dir,close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};}
function range(content:any,text:string,occurrence=0){let found:{from:number;to:number}|undefined;let seen=0;validateContent(content).descendants((node,pos)=>{if(node.isText){let at=-1;while((at=node.text!.indexOf(text,at+1))!==-1){if(seen++===occurrence)found={from:pos+at,to:pos+at+text.length};}}});assert.ok(found);return found;}

test('重复原文只改选中的第二处，其他格式和正文保留，撤销恢复',()=>{
 const f=fixture();try{
  let n=f.store.create('重复句',fromHTML('<p>前言 <strong>向量检索</strong> 找到内容。</p><p>第二次：向量检索，用语义匹配。</p>'));
  const r=range(n.content,'向量检索',1);const a=f.store.addThread(n.id,n.revision,r.from,r.to,'向量检索');n=a.note;
  const p=f.store.propose(n.id,a.threadId,n.revision,'向量检索','<p>语义搜索</p>','更直白');
  n=f.store.apply(n.id,p.id,n.revision);
  assert.equal(validateContent(n.content).textContent,'前言 向量检索 找到内容。第二次：语义搜索，用语义匹配。');
  assert.ok(toHTML(n.content).includes('<strong>向量检索</strong>'));
  assert.equal(n.threads[0].proposals[0].state,'applied');assert.equal(n.threads[0].detached,false);
  assert.equal(threadRange(validateContent(n.content),a.threadId)?.text,'语义搜索');
  assert.throws(()=>f.store.apply(n.id,p.id,n.revision),/已处理/);
  n=f.store.undo(n.id,n.revision);assert.equal(threadRange(validateContent(n.content),a.threadId)?.text,'向量检索');
 }finally{f.close();}
});
test('版本变动后拒绝旧AI建议，不能覆盖用户新写内容',()=>{
 const f=fixture();try{
  let n=f.store.create('并发',fromHTML('<p>原句。</p>'));let r=range(n.content,'原句');let a=f.store.addThread(n.id,n.revision,r.from,r.to,'原句');n=a.note;
  const p=f.store.propose(n.id,a.threadId,n.revision,'原句','<p>旧建议</p>','说明');
  n=f.store.save(n.id,n.revision,n.title,{...n.content,content:[...n.content.content!,{type:'paragraph',content:[{type:'text',text:'用户的新笔记'}]}]});
  assert.throws(()=>f.store.apply(n.id,p.id,n.revision),/已更新/);
  assert.ok(validateContent(f.store.get(n.id).content).textContent.includes('用户的新笔记'));
  assert.throws(()=>f.store.save(n.id,n.revision-1,n.title,fromHTML('<p>覆盖</p>')),/已更新/);
 }finally{f.close();}
});
test('跨段选区、重叠讨论和删除后的讨论保留',()=>{
 const f=fixture();try{
  let n=f.store.create('跨段',fromHTML('<p>第一段后半。</p><p>第二段前半。</p>'));
  const first=range(n.content,'后半。'),second=range(n.content,'第二段');
  const text=validateContent(n.content).textBetween(first.from,second.to,'\n');
  const a=f.store.addThread(n.id,n.revision,first.from,second.to,text);n=a.note;
  const b=f.store.addThread(n.id,n.revision,first.from,first.to,'后半。');n=b.note;
  assert.equal(n.threads.length,2);assert.ok(n.threads.every(t=>!t.detached));
  f.store.addMessage(n.id,a.threadId,'user','这两段是什么关系？');f.store.addMessage(n.id,a.threadId,'assistant','前后承接。');
  n=f.store.save(n.id,n.revision,n.title,fromHTML('<p>新的正文</p>'));
  assert.ok(n.threads.every(t=>t.detached));assert.equal(n.threads[0].messages.length,2);assert.equal(n.threads[0].quote,text);
  assert.throws(()=>f.store.propose(n.id,a.threadId,n.revision,text,'<p>新建议</p>',''),/已变化/);
 }finally{f.close();}
});
test('服务重启后正文高亮讨论与修改建议都保留',()=>{
 const f=fixture();let store=f.store;try{
  let n=store.create('重开',fromHTML('<p>保存<mark data-color="#fff4a3">高亮</mark>和讨论。</p>'));const r=range(n.content,'高亮');const a=store.addThread(n.id,n.revision,r.from,r.to,'高亮');n=a.note;
  store.addMessage(n.id,a.threadId,'user','如何保存？');store.addMessage(n.id,a.threadId,'assistant','本地持久化。');store.propose(n.id,a.threadId,n.revision,'高亮','<p>标记</p>','改写');
  store.close();store=new DocumentStore(f.dir,false);const restored=store.get(n.id);
  assert.deepEqual(restored.content,n.content);assert.equal(restored.threads[0].messages.length,2);assert.equal(restored.threads[0].proposals.length,1);assert.ok(toHTML(restored.content).includes('<mark'));
 }finally{store.close();rmSync(f.dir,{recursive:true,force:true});}
});
test('输入HTML清理脚本与危险链接，不保存不合法选区',()=>{
 const f=fixture();try{
  const n=f.store.create('清理',fromHTML('<p onclick="alert(1)">安全<script>alert(1)</script><a href="javascript:alert(1)">链接</a></p>'));
  const html=toHTML(n.content);assert.ok(!html.includes('script'));assert.ok(!html.includes('onclick'));assert.ok(!html.includes('javascript:'));
  assert.throws(()=>f.store.addThread(n.id,n.revision,1,3,'猜测'),/选区已变化/);
  assert.equal(f.store.get(n.id).threads.length,0);
 }finally{f.close();}
});

test('技术笔记代码块内可提问，代码示例写回保留结构和讨论',()=>{
 const f=fixture();try{
  let n=f.store.create('代码解释',fromHTML('<p>前言</p><pre><code>const n = 1;</code></pre><p>结尾</p>'));
  const r=range(n.content,'const n = 1;');const a=f.store.addThread(n.id,n.revision,r.from,r.to,'const n = 1;');n=a.note;
  assert.equal(n.threads[0].detached,false);
  const p=f.store.propose(n.id,a.threadId,n.revision,'const n = 1;','<p>const n = 2;</p>','更新示例');
  n=f.store.apply(n.id,p.id,n.revision);assert.ok(toHTML(n.content).includes('<pre>'));assert.equal(threadRange(validateContent(n.content),a.threadId)?.text,'const n = 2;');
  const other=f.store.create('段落变代码',fromHTML('<p>前缀目标后缀</p>'));const s=range(other.content,'目标');const b=f.store.addThread(other.id,other.revision,s.from,s.to,'目标');
  const pp=f.store.propose(other.id,b.threadId,b.note.revision,'目标','<pre><code>print(1)</code></pre>','代码示例');const out=f.store.apply(other.id,pp.id,b.note.revision);
  assert.ok(toHTML(out.content).includes('<pre>'));assert.equal(threadRange(validateContent(out.content),b.threadId)?.text,'print(1)');
 }finally{f.close();}
});

test('F01：段中列表、表格、标题与多段替换保留结构和前后正文，锚点仅覆盖新内容',()=>{
 const replacements=[
  {html:'<ul><li><p>第一项</p></li><li><p>第二项</p></li></ul>',type:'bulletList',text:'第一项\n第二项'},
  {html:'<ol start="3"><li><p>步骤甲</p></li><li><p>步骤乙</p></li></ol>',type:'orderedList',text:'步骤甲\n步骤乙'},
  {html:'<table><tbody><tr><td><p>单元格甲</p></td><td><p>单元格乙</p></td></tr></tbody></table>',type:'table',text:'单元格甲\n单元格乙'},
  {html:'<h2>新标题</h2>',type:'heading',text:'新标题'},
  {html:'<p>新一</p><p>新二</p>',type:'paragraph',text:'新一\n新二'},
 ];
 for(const replacement of replacements){const f=fixture();try{
  let n=f.store.create('结构替换',fromHTML('<p>前缀目标后缀</p><p>外部段落</p>'));
  const r=range(n.content,'目标'),a=f.store.addThread(n.id,n.revision,r.from,r.to,'目标');n=a.note;
  const p=f.store.propose(n.id,a.threadId,n.revision,'目标',replacement.html,'结构化替换');n=f.store.apply(n.id,p.id,n.revision);
  const node=validateContent(n.content);
  assert.equal(node.firstChild!.textContent,'前缀');assert.equal(node.firstChild!.type.name,'paragraph');
  assert.equal(node.child(1).type.name,replacement.type);
  assert.equal(node.child(node.childCount-2).textContent,'后缀');assert.equal(node.child(node.childCount-2).type.name,'paragraph');
  assert.equal(node.lastChild!.textContent,'外部段落');
  assert.equal(threadRange(node,a.threadId)?.text,replacement.text);
  assert.equal(n.threads[0].detached,false);
  const stripAnnotations=(value:any):any=>Array.isArray(value)?value.map(stripAnnotations):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='marks').map(([key,v])=>[key,stripAnnotations(v)])):value;
  const expected=fromHTML(replacement.html).content;
  assert.deepEqual(stripAnnotations(n.content.content!.slice(1,-2)),stripAnnotations(expected));
 }finally{f.close();}}
});

test('F01：跨段替换为块结构仍保留边缘前后缀及未选中格式',()=>{
 const f=fixture();try{
  let n=f.store.create('跨段替换',fromHTML('<p><strong>保留前缀</strong>第一处</p><p>第二处<em>保留后缀</em></p>'));
  const from=range(n.content,'第一处').from,to=range(n.content,'第二处').to;
  const quote=validateContent(n.content).textBetween(from,to,'\n');
  const a=f.store.addThread(n.id,n.revision,from,to,quote);n=a.note;
  const p=f.store.propose(n.id,a.threadId,n.revision,quote,'<h2>新标题</h2><p>新解释</p>','跨段结构');n=f.store.apply(n.id,p.id,n.revision);
  assert.equal(threadRange(validateContent(n.content),a.threadId)?.text,'新标题\n新解释');
  const html=toHTML(n.content);assert.ok(html.includes('<strong>保留前缀</strong>'));assert.ok(html.includes('<em>保留后缀</em>'));
  assert.equal(validateContent(n.content).child(1).type.name,'heading');
 }finally{f.close();}
});

test('F02：复制同ID到分离位置使讨论失效，拒绝写回而不删除中间正文',()=>{
 const f=fixture();try{
  let n=f.store.create('复制锚点',fromHTML('<p>甲目标乙</p>'));const r=range(n.content,'目标');const a=f.store.addThread(n.id,n.revision,r.from,r.to,'目标');n=a.note;
  const duplicate={type:'paragraph',content:[{type:'text',text:'不该修改'},{type:'text',text:'目标',marks:[{type:'annotation',attrs:{threadIds:[a.threadId]}}]}]};
  n=f.store.save(n.id,n.revision,n.title,{...n.content,content:[...n.content.content!,duplicate]});
  assert.equal(threadRange(validateContent(n.content),a.threadId),null);assert.equal(n.threads[0].detached,true);
  assert.throws(()=>f.store.propose(n.id,a.threadId,n.revision,'目标乙\n不该修改目标','<p>替换</p>',''),/已变化/);
  assert.equal(validateContent(f.store.get(n.id).content).textContent,'甲目标乙不该修改目标');
 }finally{f.close();}
});

test('F02：真正跨段且跨格式的连续选区仍可讨论与写回',()=>{
 const f=fixture();try{
  let n=f.store.create('合法跨段',fromHTML('<p>前缀甲<strong>乙</strong></p><p><em>丙</em>丁后缀</p>'));
  const from=range(n.content,'甲').from,to=range(n.content,'丁').to,quote=validateContent(n.content).textBetween(from,to,'\n');
  const a=f.store.addThread(n.id,n.revision,from,to,quote);n=a.note;
  assert.equal(threadRange(validateContent(n.content),a.threadId)?.text,quote);
  const p=f.store.propose(n.id,a.threadId,n.revision,quote,'<p>新解释</p>','简化');n=f.store.apply(n.id,p.id,n.revision);
  assert.equal(validateContent(n.content).textContent,'前缀新解释后缀');assert.equal(threadRange(validateContent(n.content),a.threadId)?.text,'新解释');
 }finally{f.close();}
});

test('跨表格单元格的写回明确拒绝，正文版本及提案状态不变',()=>{
 const f=fixture();try{
  let n=f.store.create('表格边界',fromHTML('<table><tbody><tr><td><p>甲目标</p></td><td><p>乙目标</p></td></tr></tbody></table>'));
  const from=range(n.content,'甲目标').from,to=range(n.content,'乙目标').to,quote=validateContent(n.content).textBetween(from,to,'\n');
  const a=f.store.addThread(n.id,n.revision,from,to,quote);n=a.note;
  const p=f.store.propose(n.id,a.threadId,n.revision,quote,'<p>替换</p>','');const before=f.store.get(n.id);
  assert.throws(()=>f.store.apply(n.id,p.id,n.revision),/单元格边界/);assert.deepEqual(f.store.get(n.id),before);
 }finally{f.close();}
});

test('单个表格单元格内的普通文字替换安全且保持外部单元格',()=>{
 const f=fixture();try{
  let n=f.store.create('表格单元格',fromHTML('<table><tbody><tr><td><p>前目标后</p></td><td><p>不可修改</p></td></tr></tbody></table>'));
  const r=range(n.content,'目标'),a=f.store.addThread(n.id,n.revision,r.from,r.to,'目标');n=a.note;
  const p=f.store.propose(n.id,a.threadId,n.revision,'目标','<p>新词</p>','');n=f.store.apply(n.id,p.id,n.revision);
  assert.equal(validateContent(n.content).textContent,'前新词后不可修改');assert.equal(validateContent(n.content).firstChild!.type.name,'table');assert.equal(threadRange(validateContent(n.content),a.threadId)?.text,'新词');
 }finally{f.close();}
});

test('F03：撤销关联提案变为undone，恢复重开后状态一致，不能再次撤销',()=>{
 const f=fixture();let store=f.store;try{
  let n=store.create('撤销状态',fromHTML('<p>目标</p>'));const r=range(n.content,'目标'),a=store.addThread(n.id,n.revision,r.from,r.to,'目标');n=a.note;
  const p=store.propose(n.id,a.threadId,n.revision,'目标','<p>新内容</p>','');n=store.apply(n.id,p.id,n.revision);
  assert.throws(()=>store.undo(n.id,n.revision,'other-proposal'),/不能直接撤销/);
  n=store.undo(n.id,n.revision,p.id);assert.equal(n.threads[0].proposals[0].state,'undone');assert.equal(threadRange(validateContent(n.content),a.threadId)?.text,'目标');
  assert.throws(()=>store.undo(n.id,n.revision,p.id),/没有可以撤销/);
  store.close();store=new DocumentStore(f.dir,false);assert.equal(store.get(n.id).threads[0].proposals[0].state,'undone');
 }finally{store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('F03：AI修改后的用户编辑和新增讨论不能被AI撤销覆盖',()=>{
 for(const change of ['edit','annotation']){const f=fixture();try{
  let n=f.store.create('后续编辑',fromHTML('<p>目标外部正文</p>'));const r=range(n.content,'目标'),a=f.store.addThread(n.id,n.revision,r.from,r.to,'目标');n=a.note;
  const p=f.store.propose(n.id,a.threadId,n.revision,'目标','<p>新内容</p>','');n=f.store.apply(n.id,p.id,n.revision);
  if(change==='edit')n=f.store.save(n.id,n.revision,n.title,{...n.content,content:[...n.content.content!,{type:'paragraph',content:[{type:'text',text:'用户后续笔记'}]}]});
  else {const r=range(n.content,'外部正文');n=f.store.addThread(n.id,n.revision,r.from,r.to,'外部正文').note;}
  const before=f.store.get(n.id);assert.throws(()=>f.store.undo(n.id,n.revision,p.id),/后续编辑已保留/);assert.deepEqual(f.store.get(n.id),before);
 }finally{f.close();}}
});

test('旧数据库history自动增加提案与应用版本列，不把旧历史误当可撤销AI操作',()=>{
 const f=fixture();let store=f.store;try{
  let n=store.create('旧数据库',fromHTML('<p>旧内容</p>'));n=store.save(n.id,n.revision,n.title,fromHTML('<p>已有编辑</p>'));
  store.db.exec('ALTER TABLE history DROP COLUMN proposal_id; ALTER TABLE history DROP COLUMN applied_revision;');
  store.close();store=new DocumentStore(f.dir,false);
  const columns=store.db.prepare('PRAGMA table_info(history)').all() as {name:string}[];
  assert.ok(columns.some(c=>c.name==='proposal_id'));assert.ok(columns.some(c=>c.name==='applied_revision'));
  assert.throws(()=>store.undo(n.id,n.revision),/不能直接撤销/);assert.equal(validateContent(store.get(n.id).content).textContent,'已有编辑');
 }finally{store.close();rmSync(f.dir,{recursive:true,force:true});}
});

test('文档库保留旧顺序，阅读、编辑、恢复与重启不置顶，新文档追加末尾',()=>{
 const f=fixture();let store=f.store;
 try{
  const a=store.create('甲'),b=store.create('乙'),c=store.create('丙');
  // Simulate an old database without persistent library ordering.
  store.db.exec('DROP TRIGGER append_library_note; DROP TABLE library_order;');
  store.db.prepare('UPDATE notes SET updated_at=? WHERE id=?').run('2026-01-01',a.id);
  store.db.prepare('UPDATE notes SET updated_at=? WHERE id=?').run('2026-01-03',b.id);
  store.db.prepare('UPDATE notes SET updated_at=? WHERE id=?').run('2026-01-02',c.id);
  store.close();store=new DocumentStore(f.dir,false);
  const order=[b.id,c.id,a.id];assert.deepEqual(store.list().map(n=>n.id),order);
  store.get(a.id);store.save(a.id,a.revision,'甲改名',fromHTML('<p>新增内容</p>'));
  store.tx(()=>store.restoreBundle({...c,title:'丙来自远端'}));
  assert.deepEqual(store.list().map(n=>n.id),order);
  const d=store.create('丁');order.push(d.id);assert.deepEqual(store.list().map(n=>n.id),order);
  store.close();store=new DocumentStore(f.dir,false);assert.deepEqual(store.list().map(n=>n.id),order);
 }finally{store.close();rmSync(f.dir,{recursive:true,force:true});}
});
