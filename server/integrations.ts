import { createPullService } from './github-pull.ts';
import { noteFingerprint } from './transfer.ts';
import type { Express } from 'express';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { AppError, DocumentStore, cleanHTML, fromHTML, toHTML, validateContent } from './documents.ts';
import type { Content, Note } from '../shared/types.ts';

const MAX_PAGE=5_000_000, MAX_EXPORT=8_000_000, TTL=20*60_000;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const blobSha=(value:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
const blocked=new BlockList();
for(const [network,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const)blocked.addSubnet(network,prefix,'ipv4');
for(const [network,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)blocked.addSubnet(network,prefix,'ipv6');
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
export function isPublicAddress(address:string):boolean {
 const family=isIP(address);return family===4?!blocked.check(address,'ipv4'):family===6&&globalV6.check(address,'ipv6')&&!blocked.check(address,'ipv6');
}
export function validateImportURL(input:string):URL {
 let url:URL;try{url=new URL(input);}catch{throw new AppError(400,'请输入完整的公开网页 HTTPS 地址。');}
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||isIP(url.hostname.replace(/^\[|\]$/g,''))||!url.hostname.includes('.')||/(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname))throw new AppError(400,'仅支持公开域名的 HTTPS 网页，不允许本机、内网或含登录凭证的地址。');
 url.hash='';return url;
}
/** DNS is checked on every redirect and the chosen address is pinned to the socket. */
export async function fetchPublicPage(input:string):Promise<{html:string;url:string}> {
 let url=validateImportURL(input);const deadline=Date.now()+25_000;
 for(let redirects=0;redirects<=5;redirects++){
  const remaining=deadline-Date.now();if(remaining<=0)throw new AppError(504,'网页读取超时，请稍后重试。');
  let records:{address:string;family:number}[];
  try{records=await Promise.race([lookup(url.hostname,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('DNS timeout')),Math.min(5000,remaining));timer.unref();})]);}catch{throw new AppError(502,'无法解析网页域名。');}
  // Fake-IP proxy DNS uses 198.18/15. Resolve through a fixed public DNS-over-HTTPS
  // endpoint, then pin the actual public IP. Never connect to the fake/reserved IP.
  if(records.length&&records.every(record=>/^198\.(18|19)\./.test(record.address))){
   try{
    const response=await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(url.hostname)}&type=A`,{headers:{Accept:'application/dns-json'},redirect:'error',signal:AbortSignal.timeout(Math.min(5000,Math.max(1,deadline-Date.now())))});
    if(!response.ok||!response.body)throw new Error('DNS lookup failed');
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536){await reader.cancel();throw new Error('DNS response too large');}chunks.push(part.value);}
    const answer=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(answer.Status!==0||!Array.isArray(answer.Answer))throw new Error('DNS lookup failed');
    records=answer.Answer.filter((entry:{type:number})=>entry.type===1).map((entry:{data:string})=>({address:entry.data,family:4}));
   }catch{throw new AppError(502,'代理返回了 Fake-IP 地址，公开 DNS 校验失败，请检查网络后重试。');}
  }
  if(!records.length||records.some(record=>!isPublicAddress(record.address)))throw new AppError(400,'网页地址指向内网或受限网络，已停止读取。');
  const address=records[0];
  const response=await new Promise<{status:number;location?:string;type:string;html:string}>((resolve,reject)=>{
   const req=httpsRequest(url,{method:'GET',family:address.family,headers:{'User-Agent':'PaperMind/0.3 (public-document-import)','Accept':'text/html','Accept-Encoding':'identity'},lookup:(_hostname,_options,callback)=>callback(null,address.address,address.family)},res=>{
    const status=res.statusCode||500;
    if([301,302,303,307,308].includes(status)){res.destroy();resolve({status,location:res.headers.location,type:'',html:''});return;}
    if(status!==200){res.destroy();reject(new AppError(502,`网页返回 HTTP ${status}，只能导入公开可访问的页面。`));return;}
    if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(new AppError(502,'网页使用了不支持的压缩方式。'));return;}
    const type=String(res.headers['content-type']||'');
    if(!/text\/html|application\/xhtml\+xml/i.test(type)){res.destroy();reject(new AppError(400,'这个地址不是 HTML 网页。'));return;}
    if(Number(res.headers['content-length'])>MAX_PAGE){res.destroy();reject(new AppError(413,'网页超过 5 MB，请导入较小的单篇文章。'));return;}
    const chunks:Buffer[]=[];let bytes=0;
    res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>MAX_PAGE){res.destroy();reject(new AppError(413,'网页超过 5 MB，请导入较小的单篇文章。'));}else chunks.push(chunk);});
    res.on('end',()=>resolve({status,type,html:Buffer.concat(chunks).toString('utf8')}));
    res.on('error',()=>reject(new AppError(502,'网页读取中断，请重试。')));
   });
   const timer=setTimeout(()=>req.destroy(new Error('timeout')),Math.max(1,deadline-Date.now()));timer.unref();
   req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(new AppError(502,'无法连接网页，请检查网络后重试。')));req.end();
  });
  if(response.location){url=validateImportURL(new URL(response.location,url).href);continue;}
  return {html:response.html,url:url.href};
 }
 throw new AppError(400,'网页重定向次数过多。');
}
export function extractArticle(input:{html:string;url:string}):{title:string;html:string;sourceUrl:string;warnings:string[]} {
 const {document}=parseHTML(input.html);const main=document.querySelector('main');
 const root=document.querySelector('[data-content-ref-root]')||document.querySelector('article')||main;
 if(!root)throw new AppError(422,'没有找到可识别的文章正文，请使用 GitBook 的单篇文章地址。');
 const title=(main?.querySelector('h1')?.textContent||document.querySelector('h1')?.textContent||document.querySelector('title')?.textContent||'导入的学习文档').trim().slice(0,200);
 const warnings:string[]=[];
 for(const node of root.querySelectorAll('script,style,nav,aside,footer,button,svg,noscript,[aria-hidden="true"],.sr-only'))node.remove();
 let embeds=0;
 for(const frame of root.querySelectorAll('iframe,video,audio')){
  const src=frame.getAttribute('src')||frame.querySelector('source')?.getAttribute('src');
  if(src){try{const target=new URL(src,input.url);if(target.protocol==='https:'){const p=document.createElement('p');const a=document.createElement('a');a.setAttribute('href',target.href);a.textContent=frame.getAttribute('title')||'查看原文中的视频或媒体';p.append(a);frame.replaceWith(p);embeds++;continue;}}catch{/* invalid embed removed */}}
  frame.remove();
 }
 for(const anchor of root.querySelectorAll('a[href]')){try{const url=new URL(anchor.getAttribute('href')!,input.url);if(['https:','http:','mailto:'].includes(url.protocol))anchor.setAttribute('href',url.href);else anchor.removeAttribute('href');}catch{anchor.removeAttribute('href');}}
 // External images are deliberately left as links so rendering a preview cannot
 // cause the browser to access private addresses or third-party tracking pixels.
 let images=0;
 for(const img of root.querySelectorAll('img')){const src=img.getAttribute('src');if(src){try{const url=validateImportURL(new URL(src,input.url).href);const a=document.createElement('a');a.setAttribute('href',url.href);a.textContent=img.getAttribute('alt')||'查看原文图片';img.replaceWith(a);images++;continue;}catch{/* unsafe image omitted */}}img.remove();}
 const description=root.hasAttribute('data-content-ref-root')?main?.querySelector('header p')?.outerHTML||'':'';
 const firstHeading=root.querySelector('h1');if(firstHeading?.textContent?.trim()===title)firstHeading.remove();
 const content=fromHTML(cleanHTML(description+root.innerHTML));
 const html=toHTML(content);const text=validateContent(content).textContent;
 if(text.trim().length<15)throw new AppError(422,'网页正文太少，可能需要登录或主要由脚本动态加载。');
 if(embeds)warnings.push(`${embeds} 个视频或媒体保留为原始链接，不下载媒体文件。`);
 if(images)warnings.push(`${images} 张图片保留为链接，正文与格式可以编辑。`);
 warnings.push('这是当前页面的独立副本；不会修改原网站，也不会自动跟随原网页更新。');
 return {title,html,sourceUrl:input.url,warnings};
}

function markdownInline(node:Content):string {
 if(node.type==='hardBreak')return '  \n';
 if(node.type==='image')return `![${String(node.attrs?.alt||'图片').replace(/[\[\]]/g,'')}](${node.attrs?.src||''})`;
 let text=node.text?.replace(/([\\`*_[\]<>])/g,'\\$1')??(node.content||[]).map(markdownInline).join('');
 for(const mark of node.marks||[]){if(mark.type==='bold')text=`**${text}**`;if(mark.type==='italic')text=`*${text}*`;if(mark.type==='strike')text=`~~${text}~~`;if(mark.type==='code')text='`'+(node.text||'').replace(/`/g,'&#96;')+'`';if(mark.type==='link')text=`[${text}](${String(mark.attrs?.href||'').replace(/\)/g,'%29')})`;}
 return text;
}
function markdownBlock(node:Content,depth=0):string {
 const children=node.content||[];const blocks=()=>children.map(child=>markdownBlock(child,depth)).join('\n\n');
 switch(node.type){
  case 'doc':return blocks();case 'paragraph':return children.map(markdownInline).join('');
  case 'heading':return `${'#'.repeat(Math.min(6,Math.max(1,Number(node.attrs?.level)||2)))} ${children.map(markdownInline).join('')}`;
  case 'codeBlock':{const text=children.map(n=>n.text||'').join('');const ticks='`'.repeat(Math.max(3,...(text.match(/`+/g)||[]).map(s=>s.length+1)));return `${ticks}${String(node.attrs?.language||'').replace(/[^\w+-]/g,'')}\n${text}\n${ticks}`;}
  case 'bulletList':case 'orderedList':return children.map((child,index)=>{const body=markdownBlock(child,depth+1);const prefix=node.type==='orderedList'?`${(Number(node.attrs?.start)||1)+index}. `:'- ';return prefix+body.replace(/\n/g,'\n'+' '.repeat(prefix.length));}).join('\n');
  case 'listItem':return blocks();case 'blockquote':return blocks().split('\n').map(line=>'> '+line).join('\n');
  case 'horizontalRule':return '---';case 'image':return markdownInline(node);
  case 'table':{const rows=children.map(row=>(row.content||[]).map(cell=>markdownBlock(cell).replace(/\n+/g,'<br>').replace(/\|/g,'\\|')));if(!rows.length)return '';const width=Math.max(...rows.map(r=>r.length));const line=(row:string[])=>'| '+Array.from({length:width},(_,i)=>row[i]||'').join(' | ')+' |';return [line(rows[0]),line(Array(width).fill('---')),...rows.slice(1).map(line)].join('\n');}
  case 'tableCell':case 'tableHeader':return blocks();default:return blocks()||markdownInline(node);
 }
}
export function exportMarkdown(note:Note):string {
 return `# ${note.title.replace(/\n/g,' ')}\n\n${note.sourceUrl?`来源：[原文](${note.sourceUrl.replace(/\)/g,'%29')})\n\n`:''}${markdownBlock(note.content)}\n`;
}
export function validateDestination(input:{repo:string;branch?:string;folder?:string}) {
 if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repo)||input.repo.endsWith('/.')||input.repo.endsWith('/..'))throw new AppError(400,'仓库格式应为 owner/repository。');
 const branch=input.branch?.trim();if(branch&&(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(branch)||branch.includes('..')||branch.includes('//')||branch.endsWith('/')||branch.endsWith('.')||branch.endsWith('.lock')||branch.split('/').some(s=>s.startsWith('.'))))throw new AppError(400,'分支名称无效。');
 const folder=input.folder?.trim()||'learning-notes';if(!/^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,160}$/.test(folder)||folder.includes('..')||folder.includes('//')||folder.endsWith('/')||folder.split('/').some(s=>s.startsWith('.')))throw new AppError(400,'目录只能使用安全的相对路径，不能含点开头目录或 ..。');
 return {repo:input.repo,branch,folder};
}
export interface GithubClient { request<T=any>(method:string,path:string,body?:unknown):Promise<T> }
export function githubCLI():GithubClient {
 return {request:<T>(method:string,path:string,body?:unknown)=>new Promise<T>((resolve,reject)=>{
  const args=['api','--hostname','github.com','--method',method,path];if(body!==undefined)args.push('--input','-');
  const child=spawn('gh',args,{stdio:['pipe','pipe','pipe'],env:{...process.env,GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0'}});let output='';let bytes=0;let settled=false;
  const fail=(message:string)=>{if(settled)return;settled=true;reject(new AppError(502,message));};
  const timer=setTimeout(()=>{child.kill('SIGTERM');fail('GitHub 请求超时，请稍后重试。');},30_000);timer.unref();
  child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>16_000_000){child.kill('SIGTERM');fail('GitHub 返回内容过大，暂不支持此仓库。');}else output+=chunk.toString('utf8');});
  child.stderr.resume();child.on('error',()=>fail('未找到 gh CLI，请先安装 GitHub CLI 并运行 gh auth login。'));
  child.on('close',code=>{clearTimeout(timer);if(settled)return;if(code!==0){fail('GitHub 请求失败，请检查 gh 登录、仓库权限、分支和网络。');return;}settled=true;try{resolve(JSON.parse(output));}catch{reject(new AppError(502,'GitHub 返回格式异常。'));}});
  child.stdin.on('error',()=>{});child.stdin.end(body===undefined?undefined:JSON.stringify(body));
 })};
}
export interface SyncFile {path:string;status:'add'|'update'|'unchanged';content:string;previousContent?:string;bytes:number}
export interface SyncPreview {previewId:string;repo:string;branch:string;folder:string;baseSha:string;files:SyncFile[];warnings:string[]}
export interface Registry {destinations:Record<string,{files:Record<string,string>;notes?:Record<string,string>}>}
export interface IntegrationDependencies {fetchPage?:(url:string)=>Promise<{html:string;url:string}>;github?:GithubClient;beforePush?:(repo:string)=>Promise<void>}
export async function createIntegrationService(store:DocumentStore,dataDir:string,deps:IntegrationDependencies={}) {
 const github=deps.github||githubCLI();const fetchPage=deps.fetchPage||fetchPublicPage;
 await mkdir(dataDir,{recursive:true,mode:0o700});const registryPath=join(dataDir,'github-sync.json');
 store.db.exec('CREATE TABLE IF NOT EXISTS github_sync_registry(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
 const saved=store.db.prepare('SELECT value FROM github_sync_registry WHERE id=1').get() as {value:string}|undefined;
 let initial:Registry={destinations:{}};
 try{if(saved)initial=JSON.parse(saved.value);else{try{initial=JSON.parse(await readFile(registryPath,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}if(!initial.destinations||typeof initial.destinations!=='object')throw new Error('invalid');}catch{throw new AppError(500,'GitHub 同步记录无法读取，已停止同步以保护远端文件。');}
 store.db.prepare('INSERT OR IGNORE INTO github_sync_registry VALUES(1,?)').run(JSON.stringify(initial));
 const getRegistry=():Registry=>JSON.parse((store.db.prepare('SELECT value FROM github_sync_registry WHERE id=1').get() as {value:string}).value);
 const saveRegistry=(next:Registry)=>{store.db.prepare('UPDATE github_sync_registry SET value=? WHERE id=1').run(JSON.stringify(next));};

 const imports=new Map<string,{expires:number;result:ReturnType<typeof extractArticle>;noteId?:string}>();
 const syncs=new Map<string,{expires:number;preview:SyncPreview;noteIds:string[];snapshot:string;snapshotSource:string;registrySnapshot:string;treeSha:string;result?:unknown}>();let pushing=false;
 const destinationKey=(repo:string,branch:string,folder:string)=>`${repo}:${branch}:${folder}`;
 const snapshot=(ids:string[])=>JSON.stringify(ids.map(id=>store.get(id)));
 const prune=()=>{for(const [id,p] of imports)if(p.expires<Date.now())imports.delete(id);for(const [id,p] of syncs)if(p.expires<Date.now())syncs.delete(id);};
 async function githubStatus(){try{const user=await github.request<{login:string}>('GET','user');return {available:true,authenticated:true,login:user.login,message:'已通过本机 gh CLI 登录。'};}catch(e){return {available:!(e instanceof Error&&e.message.includes('未找到')),authenticated:false,message:e instanceof Error?e.message:'GitHub 不可用'};}}
 async function importPreview(url:string){prune();validateImportURL(url);const page=await fetchPage(url);const result=extractArticle(page);const previewId=randomUUID();imports.set(previewId,{expires:Date.now()+TTL,result});return {previewId,...result,url:result.sourceUrl};}
 function importNote(previewId:string){prune();const preview=imports.get(previewId);if(!preview)throw new AppError(409,'导入预览已过期，请重新预览。');if(preview.noteId)return {note:store.get(preview.noteId)};const note=store.create(preview.result.title,fromHTML(preview.result.html),preview.result.sourceUrl);preview.noteId=note.id;return {note};}
 async function ref(repo:string,branch:string){const result=await github.request<{object:{sha:string}}>('GET',`repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);return result.object.sha;}
 async function syncPreview(input:{repo:string;branch?:string;folder?:string;noteIds:string[]}){
  prune();const destination=validateDestination(input);
  if(!Array.isArray(input.noteIds)||!input.noteIds.length||input.noteIds.length>100||new Set(input.noteIds).size!==input.noteIds.length)throw new AppError(400,'请选择 1 至 100 篇不重复的文档。');
  const noteIds=[...input.noteIds].sort();const noteSnapshot=snapshot(noteIds);const notes=JSON.parse(noteSnapshot) as Note[];
  const repo=await github.request<{default_branch:string;permissions?:{push?:boolean};private:boolean}>('GET',`repos/${destination.repo}`);
  if(repo.permissions?.push===false)throw new AppError(403,'当前账号没有该仓库的写入权限。');
  const branch=destination.branch||repo.default_branch;if(!branch)throw new AppError(400,'请先在 GitHub 创建包含 README 的仓库分支。');validateDestination({...destination,branch});
  const baseSha=await ref(destination.repo,branch);
  const commit=await github.request<{tree:{sha:string}}>('GET',`repos/${destination.repo}/git/commits/${baseSha}`);
  const tree=await github.request<{truncated:boolean;tree:{path:string;type:string;sha:string;mode:string}[]}>('GET',`repos/${destination.repo}/git/trees/${commit.tree.sha}?recursive=1`);
  if(tree.truncated)throw new AppError(413,'仓库文件过多，不能完整验证文件冲突，已停止同步。');
  const key=destinationKey(destination.repo,branch,destination.folder),tracked=getRegistry().destinations[key]?.files||{};
  const exports=notes.flatMap(note=>{
   if(!/^[a-f0-9-]{36}$/.test(note.id))throw new AppError(400,'文档 ID 不适合导出。');
   const prefix=`${destination.folder}/${note.id}`;
   return [{path:`${prefix}/README.md`,content:exportMarkdown(note)},{path:`${prefix}/document.json`,content:JSON.stringify({format:'yejian-document-v1',id:note.id,title:note.title,revision:note.revision,sourceUrl:note.sourceUrl,updatedAt:note.updatedAt,content:note.content},null,2)+'\n'},{path:`${prefix}/comments.json`,content:JSON.stringify({format:'yejian-discussions-v1',noteId:note.id,threads:note.threads,documentMessages:note.documentMessages||[]},null,2)+'\n'}];
  });
  if(exports.reduce((sum,f)=>sum+Buffer.byteLength(f.content),0)>MAX_EXPORT)throw new AppError(413,'本次导出超过 8 MB，请减少文档数量。');
  const files:SyncFile[]=[];
  for(const file of exports){
   const remote=tree.tree.find(entry=>entry.path===file.path);
   const parts=file.path.split('/');for(let i=1;i<parts.length;i++){const ancestor=tree.tree.find(entry=>entry.path===parts.slice(0,i).join('/'));if(ancestor&&ancestor.type!=='tree')throw new AppError(409,`远端路径 ${ancestor.path} 不是文件夹，不能同步。`);}
   if(remote&&(!tracked[file.path]||remote.sha!==tracked[file.path]||remote.type!=='blob'||remote.mode!=='100644'))throw new AppError(409,`远端文件 ${file.path} 未由本应用登记或已被其他人修改。请选择新目录，或先处理远端修改。`);
   const status:SyncFile['status']=!remote?'add':remote.sha===blobSha(file.content)?'unchanged':'update';
   let previousContent:string|undefined;
   if(remote&&status==='update'){const blob=await github.request<{encoding:string;content:string;size:number}>('GET',`repos/${destination.repo}/git/blobs/${remote.sha}`);if(blob.encoding!=='base64'||blob.size>MAX_EXPORT)throw new AppError(413,'远端文件过大或编码不受支持。');previousContent=Buffer.from(blob.content.replace(/\n/g,''),'base64').toString('utf8');}
   files.push({...file,status,previousContent,bytes:Buffer.byteLength(file.content)});
  }
  const preview:SyncPreview={previewId:randomUUID(),repo:destination.repo,branch,folder:destination.folder,baseSha,files,warnings:[`目标仓库是${repo.private?'私有':'公开'}仓库。正文、来源和所选文档的全部讨论将被上传。`,'上传当前文档及讨论；不会删除其他文件。换电脑可使用「从 GitHub 拉取」。']};
  syncs.set(preview.previewId,{expires:Date.now()+TTL,preview,noteIds,snapshot:hash(noteSnapshot),snapshotSource:noteSnapshot,registrySnapshot:hash(JSON.stringify(tracked)),treeSha:commit.tree.sha});return preview;
 }
 async function push(previewId:string){
  prune();const planned=syncs.get(previewId);if(!planned)throw new AppError(409,'同步预览已过期，请重新预览。');if(planned.result)return planned.result;
  if(pushing)throw new AppError(409,'另一次同步正在执行，请稍后重试。');pushing=true;
  try{
   const p=planned.preview,key=destinationKey(p.repo,p.branch,p.folder);const tracked=getRegistry().destinations[key]?.files||{};
   if(hash(snapshot(planned.noteIds))!==planned.snapshot||hash(JSON.stringify(tracked))!==planned.registrySnapshot)throw new AppError(409,'文档或同步记录在预览后已变化，请重新预览再确认。');
   if(await ref(p.repo,p.branch)!==p.baseSha)throw new AppError(409,'GitHub 分支在预览后已有新提交，请重新预览。');
   const changes=p.files.filter(file=>file.status!=='unchanged');
   if(!changes.length){const registry=getRegistry();saveRegistry({destinations:{...registry.destinations,[key]:{files:tracked,notes:{...registry.destinations[key]?.notes,...Object.fromEntries(planned.noteIds.map(id=>[id,noteFingerprint(store.get(id))]))}}}});planned.result={repo:p.repo,branch:p.branch,commitSha:p.baseSha,url:`https://github.com/${p.repo}/tree/${encodeURIComponent(p.branch)}/${p.folder}`,files:0};return planned.result;}
   await deps.beforePush?.(p.repo);
   const treeEntries=[];
   for(const file of changes){const blob=await github.request<{sha:string}>('POST',`repos/${p.repo}/git/blobs`,{content:file.content,encoding:'utf-8'});treeEntries.push({path:file.path,mode:'100644',type:'blob',sha:blob.sha});}
   const tree=await github.request<{sha:string}>('POST',`repos/${p.repo}/git/trees`,{base_tree:planned.treeSha,tree:treeEntries});
   const commit=await github.request<{sha:string}>('POST',`repos/${p.repo}/git/commits`,{message:`docs: sync ${planned.noteIds.length} PaperMind learning document(s)`,tree:tree.sha,parents:[p.baseSha]});
   // Never force-push. A concurrent advance cannot be fast-forwarded by this
   // single-parent commit, so GitHub rejects it without losing remote changes.
   await github.request('PATCH',`repos/${p.repo}/git/refs/heads/${encodeURIComponent(p.branch)}`,{sha:commit.sha,force:false});
   const registry=getRegistry();
   const next:Registry={destinations:{...registry.destinations,[key]:{files:{...tracked,...Object.fromEntries(p.files.map(file=>[file.path,blobSha(file.content)]))},notes:{...registry.destinations[key]?.notes,...Object.fromEntries(planned.noteIds.map(id=>[id,noteFingerprint(JSON.parse(planned.snapshotSource!).find((n:Note)=>n.id===id))]))}}}};
   try{saveRegistry(next);}catch{throw new AppError(500,`GitHub 已提交 ${commit.sha}，但本机同步记录保存失败，请先检查本机存储。`);}

   planned.result={repo:p.repo,branch:p.branch,commitSha:commit.sha,url:`https://github.com/${p.repo}/commit/${commit.sha}`,files:changes.length};return planned.result;
  }finally{pushing=false;}
 }
 const pulls=createPullService(store,github,{getRegistry,saveRegistry,isBusy:()=>pushing,setBusy:v=>{pushing=v;},markdown:exportMarkdown});
 return {githubStatus,importPreview,importNote,syncPreview,push,...pulls};
}
export async function installIntegrationRoutes(app:Express,store:DocumentStore,dataDir:string,deps:IntegrationDependencies={}) {
 const service=await createIntegrationService(store,dataDir,deps);
 app.get('/api/github/status',async(_req,res)=>res.json(await service.githubStatus()));
 app.post('/api/import/preview',async(req,res)=>{const {url}=z.object({url:z.string().url().max(2000)}).parse(req.body);res.json(await service.importPreview(url));});
 app.post('/api/import',(req,res)=>{const {previewId}=z.object({previewId:z.string().uuid()}).parse(req.body);res.json(service.importNote(previewId));});
 app.post('/api/github/preview',async(req,res)=>{const body=z.object({repo:z.string().max(150),branch:z.string().max(180).optional(),folder:z.string().max(160).optional(),noteIds:z.array(z.string().uuid()).min(1).max(100)}).parse(req.body);res.json(await service.syncPreview(body));});
 app.post('/api/github/push',async(req,res)=>{const {previewId}=z.object({previewId:z.string().uuid()}).parse(req.body);res.json(await service.push(previewId));});
 app.post('/api/github/pull/preview',async(req,res)=>{const input=z.object({repo:z.string().max(150),branch:z.string().max(180).optional(),folder:z.string().max(160).optional()}).parse(req.body);res.json(await service.pullPreview(validateDestination(input)));});
 app.post('/api/github/pull',async(req,res)=>{const {previewId}=z.object({previewId:z.string().uuid()}).parse(req.body);res.json(await service.pull(previewId));});
 return service;
}
