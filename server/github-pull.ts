import { randomUUID } from 'node:crypto';
import type { GithubClient, Registry } from './integrations.ts';
import { AppError, DocumentStore, preserveDiscussionAnchors, toHTML } from './documents.ts';
import { decodeBundle, noteFingerprint, parseTextDocument } from './transfer.ts';
import type { Note } from '../shared/types.ts';
interface Destination {repo:string;branch?:string;folder:string}
interface PullItem {id:string;title:string;status:'add'|'update'|'conflict'|'unchanged'|'local';html:string;localHtml?:string;warnings:string[]}
export interface PullPreview {previewId:string;repo:string;branch:string;folder:string;baseSha:string;items:PullItem[]}
export function createPullService(store:DocumentStore,github:GithubClient,options:{getRegistry:()=>Registry;saveRegistry:(r:Registry)=>void;isBusy:()=>boolean;setBusy:(v:boolean)=>void;markdown:(n:Note)=>string}) {
 type Plan={preview:PullPreview;notes:Note[];files:Record<string,string>;locals:Record<string,string|null>;registrySnapshot:string;expires:number;result?:{notes:Note[];backups:Note[]}};
 const plans=new Map<string,Plan>();const key=(d:{repo:string;branch:string;folder:string})=>`${d.repo}:${d.branch}:${d.folder}`;
 const local=(id:string)=>store.db.prepare('SELECT id FROM notes WHERE id=?').get(id)?store.get(id):null;
 const localHash=(id:string)=>{const n=local(id);return n?JSON.stringify(n):null;};
 const head=async(repo:string,branch:string)=>(await github.request('GET',`repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha as string;
 async function pullPreview(d:Destination):Promise<PullPreview>{
  for(const [id,p] of plans)if(p.expires<Date.now())plans.delete(id);
  const meta=await github.request('GET',`repos/${d.repo}`);const branch=d.branch||meta.default_branch;if(!branch)throw new AppError(400,'目标仓库还没有分支。');
  const baseSha=await head(d.repo,branch);const commit=await github.request('GET',`repos/${d.repo}/git/commits/${baseSha}`);
  const tree=await github.request<{truncated:boolean;tree:{path:string;type:string;sha:string;mode:string}[]}>('GET',`repos/${d.repo}/git/trees/${commit.tree.sha}?recursive=1`);
  if(tree.truncated)throw new AppError(413,'仓库目录过大，无法完整检查。');
  const entries=tree.tree.filter(e=>e.path.startsWith(d.folder+'/')&&e.path.endsWith('/document.json')&&e.path.slice(d.folder.length+1).split('/').length===2);
  if(!entries.length)throw new AppError(404,'这个目录里没有PaperMind笔记。请先在原电脑上传笔记，或用 Agent 交付命令导入 Markdown。');
  if(entries.length>100)throw new AppError(413,'一次最多恢复 100 篇笔记，请缩小目录范围。');
  const dest={...d,branch},registry=options.getRegistry(),tracked=registry.destinations[key(dest)],files:Record<string,string>={},notes:Note[]=[],locals:Record<string,string|null>={},items:PullItem[]=[];
  let bytes=0;
  const read=async(path:string)=>{const e=tree.tree.find(e=>e.path===path);if(!e||e.type!=='blob'||e.mode!=='100644')throw new AppError(400,`缺少普通文件：${path}`);const b=await github.request('GET',`repos/${d.repo}/git/blobs/${e.sha}`);if(b.encoding!=='base64'||!Number.isFinite(b.size)||b.size>8_000_000)throw new AppError(413,'文件过大或编码无效。');const value=Buffer.from(b.content.replace(/\n/g,''),'base64').toString('utf8');bytes+=Buffer.byteLength(value);if(bytes>8_000_000)throw new AppError(413,'本次拉取超过 8 MB，请缩小目录范围。');files[path]=e.sha;return value;};
  for(const entry of entries){
   const prefix=entry.path.slice(0,-'/document.json'.length);const [document,comments,markdown]=await Promise.all([read(entry.path),read(prefix+'/comments.json'),read(prefix+'/README.md')]);
   let n:Note;try{n=decodeBundle(document,comments);}catch(e){throw new AppError(400,`远端笔记格式无效：${prefix}。${e instanceof AppError?e.message:''}`);}
   if(prefix!==`${d.folder}/${n.id}`)throw new AppError(400,'文档 ID 与文件夹不一致。');
   const warnings:string[]=[];
   if(markdown.trim()!==options.markdown(n).trim()){
    const parsed=parseTextDocument(markdown.replace(/^来源：\[原文\]\([^\n]+\)\s*$/m,''),'markdown');
    n={...n,title:parsed.title,content:preserveDiscussionAnchors(n,parsed.content)};
    warnings.push('README 正文有外部编辑：本次采用 Markdown 正文，尽量重新定位原有讨论；Markdown 不包含的排版可能变化。');
   }
   const old=local(n.id);locals[n.id]=old?JSON.stringify(old):null;
   const unchanged=['README.md','document.json','comments.json'].every(name=>files[`${prefix}/${name}`]===tracked?.files[`${prefix}/${name}`]);
   const status:PullItem['status']=!old?'add':noteFingerprint(old)===noteFingerprint(n)?'unchanged':unchanged?'local':tracked?.notes?.[n.id]===noteFingerprint(old)?'update':'conflict';
   if(status==='conflict')warnings.push('本机也有改动：确认后先保留完整的本机冲突副本，再把远端版本恢复为这篇文档。');
   notes.push(n);items.push({id:n.id,title:n.title,status,html:toHTML(n.content),localHtml:old?toHTML(old.content):undefined,warnings});
  }
  const preview={previewId:randomUUID(),repo:d.repo,branch,folder:d.folder,baseSha,items};
  plans.set(preview.previewId,{preview,notes,files,locals,registrySnapshot:JSON.stringify(tracked||{}),expires:Date.now()+20*60_000});return preview;
 }
 async function pull(id:string){
  const plan=plans.get(id);if(!plan||plan.expires<Date.now())throw new AppError(409,'拉取预览已过期，请重新预览。');if(plan.result)return plan.result;
  if(options.isBusy())throw new AppError(409,'另一次同步正在执行。');options.setBusy(true);
  try{
   const p=plan.preview,destKey=key(p),registry=options.getRegistry();
   if(await head(p.repo,p.branch)!==p.baseSha)throw new AppError(409,'远端在预览后已有变化，请重新预览。');
   if(JSON.stringify(registry.destinations[destKey]||{})!==plan.registrySnapshot)throw new AppError(409,'同步记录已变化，请重新预览。');
   for(const n of plan.notes)if(localHash(n.id)!==plan.locals[n.id])throw new AppError(409,'本机正文或讨论在预览后已有变化，请重新预览。');
   const result=store.tx(()=>{
    const restored:Note[]=[],backups:Note[]=[];const tracked=registry.destinations[destKey]||{files:{},notes:{}};const bases={...tracked.notes};
    for(const incoming of plan.notes){const item=p.items.find(i=>i.id===incoming.id)!;
     if(item.status==='local'){restored.push(store.get(incoming.id));continue;}
     if(item.status==='conflict'){const old=store.get(incoming.id);backups.push(store.restoreBundle({...old,title:old.title.slice(0,180)+'（本机冲突副本）'},true));}
     const saved=item.status==='unchanged'?store.get(incoming.id):store.restoreBundle(incoming);restored.push(saved);bases[incoming.id]=noteFingerprint(saved);
    }
    options.saveRegistry({destinations:{...registry.destinations,[destKey]:{files:{...tracked.files,...plan.files},notes:bases}}});
    return {notes:restored,backups};
   });
   plan.result=result;return result;
  }finally{options.setBusy(false);}
 }
 return {pullPreview,pull};
}
