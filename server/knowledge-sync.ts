import type { Express } from 'express';
import { z } from 'zod';
import { AppError, DocumentStore } from './documents.ts';
import { githubCLI, validateDestination, type GithubClient, type createIntegrationService } from './integrations.ts';
import { noteFingerprint } from './transfer.ts';

export interface KnowledgeConfig {repo:string;branch:string;folder:string;enabled:boolean;excludedIds:string[]}
type Service=Awaited<ReturnType<typeof createIntegrationService>>;
/** Fail closed: automatic knowledge sync is only for the signed-in user's private repository. */
export async function assertPrivateOwner(github:GithubClient,repo:string){
 const [user,meta,members,invitations]=await Promise.all([
  github.request('GET','user'),github.request('GET',`repos/${repo}`),
  github.request<any[]>('GET',`repos/${repo}/collaborators?per_page=100`),
  github.request<any[]>('GET',`repos/${repo}/invitations?per_page=100`),
 ]);
 if(meta.private!==true||meta.visibility!=='private'||meta.owner?.type!=='User'||meta.owner.login!==user.login||meta.permissions?.admin!==true||members.some(m=>m.login!==user.login)||invitations.length)
  throw new AppError(403,'知识库必须是当前账号独享的私有仓库，且没有协作者或待接受邀请。同步已停止。');
 return meta;
}
export function knowledgeConfig(store:DocumentStore):KnowledgeConfig|null {
 store.db.exec('CREATE TABLE IF NOT EXISTS knowledge_sync(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
 const row=store.db.prepare('SELECT value FROM knowledge_sync WHERE id=1').get() as {value:string}|undefined;
 return row?JSON.parse(row.value):null;
}
export function createKnowledgeSync(store:DocumentStore,service:Service,github:GithubClient=githubCLI()){
 let config=knowledgeConfig(store),timer:ReturnType<typeof setInterval>|undefined,running:Promise<unknown>|null=null;
 let lastHead='',lastSuccess:string|null=null,error:string|null=null;
 const save=()=>store.db.prepare('INSERT INTO knowledge_sync VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(config));
 const status=()=>({config,busy:!!running,lastSuccess,error,intervalSeconds:120});
 async function configure(input:KnowledgeConfig){
  if(running)throw new AppError(409,'正在同步，请稍后修改配置。');
  const d=validateDestination(input);await assertPrivateOwner(github,d.repo);
  config={...d,branch:input.branch||'main',enabled:input.enabled,excludedIds:input.excludedIds};save();lastHead='';error=null;return status();
 }
 async function cycle(){
  if(!config?.enabled)return status();
  const c={...config};await assertPrivateOwner(github,c.repo);
  const head=(await github.request('GET',`repos/${c.repo}/git/ref/heads/${encodeURIComponent(c.branch)}`)).object.sha;
  let remoteIds:Set<string>|undefined;
  if(head!==lastHead){
   try{
    const preview=await service.pullPreview(c);remoteIds=new Set(preview.items.map(i=>i.id));
    if(preview.items.some(i=>i.status==='conflict'))throw new AppError(409,'本机与 GitHub 同时修改了同一篇笔记。自动同步已暂停；请在 GitHub 同步窗口预览拉取，保留冲突副本后继续。');
    // User exclusions must never be silently reintroduced by background pulls.
    if(preview.items.some(i=>c.excludedIds.includes(i.id)&&i.status!=='unchanged'))throw new AppError(409,'远端包含本机排除的文档，请手动检查拉取预览。');
    await service.pull(preview.previewId);
   }catch(e){if(!(e instanceof AppError&&e.status===404&&e.message.startsWith('这个目录里没有')))throw e;remoteIds=new Set();}
  }
  const registry=store.db.prepare('SELECT value FROM github_sync_registry WHERE id=1').get() as {value:string}|undefined;
  const baseline=registry?JSON.parse(registry.value).destinations[`${c.repo}:${c.branch}:${c.folder}`]?.notes||{}:{};
  // Compare semantic content to the shared baseline. Local revision/timestamps after
  // a restore must not cause two computers to endlessly exchange metadata commits.
  const ids=store.list().map(n=>n.id).filter(id=>!c.excludedIds.includes(id)&&(baseline[id]!==noteFingerprint(store.get(id))||(remoteIds&&!remoteIds.has(id))));
  if(ids.length){
   const preview=await service.syncPreview({...c,noteIds:ids});
   await assertPrivateOwner(github,c.repo);
   const result=await service.push(preview.previewId) as {commitSha:string};lastHead=result.commitSha;
  }else lastHead=head;
  lastSuccess=new Date().toISOString();error=null;return status();
 }
 function sync(){
  if(running)return running;
  running=cycle().catch(e=>{error=e instanceof Error?e.message:'同步失败';throw e;}).finally(()=>{running=null;});return running;
 }
 return {status,configure,sync,
  pause(){if(running)throw new AppError(409,'正在同步，请完成后再暂停。');if(config){config={...config,enabled:false};save();}return status();},
  start(){if(timer)return;timer=setInterval(()=>{void sync().catch(()=>{});},120_000);timer.unref();void sync().catch(()=>{});},
  async stop(){if(timer)clearInterval(timer);timer=undefined;await running?.catch(()=>{});},
 };
}
export function installKnowledgeRoutes(app:Express,sync:ReturnType<typeof createKnowledgeSync>){
 app.get('/api/knowledge/status',(_req,res)=>res.json(sync.status()));
 app.post('/api/knowledge/configure',async(req,res)=>{
  const input=z.object({repo:z.string().max(150),branch:z.string().max(180).default('main'),folder:z.string().max(160).default('learning-notes'),enabled:z.boolean().default(true),excludedIds:z.array(z.string().uuid()).max(1000).default([])}).parse(req.body);
  res.json(await sync.configure(input));
 });
 app.post('/api/knowledge/sync',async(_req,res)=>{await sync.sync();res.json(sync.status());});
 app.post('/api/knowledge/pause',(_req,res)=>res.json(sync.pause()));
}
