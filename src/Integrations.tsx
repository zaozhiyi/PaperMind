import { KnowledgeSync } from './KnowledgeSync';
import { useEffect, useState } from 'react';
import { Download, Github, X, LoaderCircle, Check, ExternalLink } from 'lucide-react';
import { api } from './api';
import type { Note } from '../shared/types';

type ImportPreview={previewId:string;title:string;html:string;sourceUrl:string;warnings:string[]};
type SyncPreview={previewId:string;repo:string;branch:string;folder:string;baseSha:string;files:{path:string;status:'add'|'update'|'unchanged';content:string;previousContent?:string;bytes:number}[];warnings:string[]};
type PullPreview={previewId:string;repo:string;branch:string;items:{id:string;title:string;status:'add'|'update'|'conflict'|'unchanged'|'local';html:string;localHtml?:string;warnings:string[]}[]};
type GithubStatus={available:boolean;authenticated:boolean;login?:string;message:string};
export function Integrations({note,onNote,beforeAction,disabled,mode,onClose}:{note:Note|null;onNote:(note:Note)=>void;beforeAction:()=>Promise<void>;disabled:boolean;mode:'import'|'github'|null;onClose:()=>void}) {
 const [working,setWorking]=useState(false),[error,setError]=useState('');
 const [url,setUrl]=useState(''),[imported,setImported]=useState<ImportPreview|null>(null);
 const [direction,setDirection]=useState<'push'|'pull'>('push'),[pullPreview,setPullPreview]=useState<PullPreview|null>(null),[pullResult,setPullResult]=useState<{notes:Note[];backups:Note[]}|null>(null);
 const [github,setGithub]=useState<GithubStatus|null>(null),[repo,setRepo]=useState(()=>localStorage.getItem('yejian-github-repo')||''),[branch,setBranch]=useState(()=>localStorage.getItem('yejian-github-branch')||''),[folder,setFolder]=useState(()=>localStorage.getItem('yejian-github-folder')||'learning-notes');
 const [preview,setPreview]=useState<SyncPreview|null>(null),[result,setResult]=useState<{url:string;commitSha:string;files:number}|null>(null);
 const run=async(fn:()=>Promise<void>)=>{if(working)return;setWorking(true);setError('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'操作未完成，请重试。');}finally{setWorking(false);}};
 useEffect(()=>{setError('');setResult(null);setPreview(null);setPullPreview(null);setPullResult(null);if(mode==='github')void run(async()=>{setGithub(await api<GithubStatus>('/api/github/status'));const s=await api<{config:{repo:string;branch:string;folder:string}|null}>('/api/knowledge/status');if(s.config){setRepo(s.config.repo);setBranch(s.config.branch);setFolder(s.config.folder);}});},[mode]);
 const close=()=>{if(!working){onClose();setError('');}};
 useEffect(()=>{if(!mode||working)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')close();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[mode,working,onClose]);
 const invalidates=()=>{setPreview(null);setResult(null);setPullPreview(null);setPullResult(null);};
 const destination=()=>{localStorage.setItem('yejian-github-repo',repo.trim());localStorage.setItem('yejian-github-branch',branch.trim());localStorage.setItem('yejian-github-folder',folder.trim());return {repo:repo.trim(),...(branch.trim()?{branch:branch.trim()}:{}),folder:folder.trim()};};
 return <>
  {mode&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><section className="modal" style={{width:740,maxWidth:'100%'}} role="dialog" aria-modal="true" tabIndex={-1} aria-label={mode==='import'?'导入公开文章':'同步到 GitHub'}>
   <button className="icon-button modal-close" aria-label="关闭导入同步窗口" onClick={close} disabled={working}><X size={18}/></button>
   <h2>{mode==='import'?'把文章变成自己的学习副本':'GitHub 笔记同步'}</h2>
   {error&&<div className="modal-error" role="alert">{error}</div>}
   {mode==='import'?<>
    <p>粘贴公开 GitBook 的单篇文章地址，先检查正文，再导入为可编辑文档。</p>
    <label className="field-label">文章地址<input aria-label="公开文章地址" type="url" value={url} onChange={e=>{setUrl(e.target.value);setImported(null);}} placeholder="https://example.gitbook.io/notes/article" disabled={working}/></label>
    <button className="secondary-button" disabled={working||!url.trim()} onClick={()=>void run(async()=>{await beforeAction();setImported(await api<ImportPreview>('/api/import/preview',{url:url.trim()}));})}>{working?<LoaderCircle size={14} className="spin"/>:<Download size={14}/>}预览文章</button>
    {imported&&<div style={{marginTop:20}}><h3 style={{fontSize:18}}>{imported.title}</h3><a href={imported.sourceUrl} target="_blank" rel="noreferrer" style={{fontSize:12,overflowWrap:'anywhere'}}>查看原文 <ExternalLink size={12}/></a>
     <div className="document-editor" style={{maxHeight:'36vh',overflow:'auto',padding:16,border:'1px solid var(--line)',borderRadius:8,margin:'14px 0'}} dangerouslySetInnerHTML={{__html:imported.html}}/>
     {imported.warnings.map(w=><p key={w} style={{fontSize:12,lineHeight:1.8,color:'var(--muted)'}}>{w}</p>)}
     <button className="primary-button" disabled={working||disabled} onClick={()=>void run(async()=>{await beforeAction();const result=await api<{note:Note}>('/api/import',{previewId:imported.previewId});onNote(result.note);onClose();setImported(null);setUrl('');})}><Check size={15}/>导入为我的文档</button>
    </div>}
   </>:<>
    <KnowledgeSync/><div className="theme-modes" role="group" aria-label="同步方向"><button aria-pressed={direction==='push'} className={direction==='push'?'selected':''} disabled={working} onClick={()=>{setDirection('push');invalidates();}}>上传当前文档</button><button aria-pressed={direction==='pull'} className={direction==='pull'?'selected':''} disabled={working} onClick={()=>{setDirection('pull');invalidates();}}>从 GitHub 拉取</button></div><p style={{fontSize:12,lineHeight:1.8,color:'var(--muted)',marginTop:14}}>{direction==='push'?`上传「${note?.title||'未选中文档'}」的正文与讨论。`:'预览并恢复仓库中的PaperMind笔记；两边都有修改时保留本机冲突副本。'}</p>
    <div className="login-state">{github?.authenticated?`已通过本机 GitHub CLI 登录：${github.login}`:github?.message||'正在检查 GitHub 登录…'}{github&&!github.authenticated&&<p>在终端运行 <code>gh auth login</code> 后，关闭并重新打开此窗口。</p>}</div>
    <label className="field-label">目标仓库<input aria-label="GitHub 仓库" value={repo} placeholder="owner/repository" disabled={working} onChange={e=>{setRepo(e.target.value);invalidates();}}/></label>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}><label className="field-label">分支（可留空使用默认分支）<input aria-label="GitHub 分支" value={branch} placeholder="main" disabled={working} onChange={e=>{setBranch(e.target.value);invalidates();}}/></label><label className="field-label">存放目录<input aria-label="GitHub 目录" value={folder} disabled={working} onChange={e=>{setFolder(e.target.value);invalidates();}}/></label></div>
    {direction==='push'&&<><button className="secondary-button" disabled={working||!github?.authenticated||!repo.trim()||!note||disabled} onClick={()=>void run(async()=>{await beforeAction();setResult(null);setPreview(await api<SyncPreview>('/api/github/preview',{...destination(),noteIds:[note!.id]}));})}>{working?<LoaderCircle size={14} className="spin"/>:<Github size={14}/>}预览将上传的内容</button>
    {preview&&<div style={{marginTop:20}}><p style={{fontSize:12}}>目标：<strong>{preview.repo}</strong> · {preview.branch} · {preview.folder}</p>{preview.warnings.map(w=><p key={w} style={{fontSize:12,lineHeight:1.8,color:'var(--muted)'}}>{w}</p>)}
     <div style={{maxHeight:'32vh',overflow:'auto',border:'1px solid var(--line)',borderRadius:8,padding:12}}>{preview.files.map(file=><details key={file.path} style={{marginBottom:10}}><summary style={{fontSize:12,cursor:'pointer',overflowWrap:'anywhere'}}><strong>{file.status==='add'?'新增':file.status==='update'?'修改':'未变化'}</strong> · {file.path} · {Math.ceil(file.bytes/1024)} KB</summary>{file.previousContent!==undefined&&<><p style={{fontSize:11}}>远端原内容</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:11,maxHeight:200,overflow:'auto',background:'var(--soft)',padding:10}}>{file.previousContent}</pre></>}<p style={{fontSize:11}}>本次内容</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:11,maxHeight:260,overflow:'auto',background:'var(--soft)',padding:10}}>{file.content}</pre></details>)}</div>
     {!result&&<button className="primary-button" style={{marginTop:16}} disabled={working||disabled||preview.files.every(f=>f.status==='unchanged')} onClick={()=>void run(async()=>{await beforeAction();setResult(await api('/api/github/push',{previewId:preview.previewId}));})}><Github size={15}/>确认上传以上文件</button>}
     {preview.files.every(f=>f.status==='unchanged')&&<p style={{fontSize:12}}>当前文档与远端一致，无需上传。</p>}
    </div>}
    {result&&<div className="login-state"><p><Check size={15}/>已同步 {result.files} 个文件。<a href={result.url} target="_blank" rel="noreferrer">查看 GitHub 提交</a></p></div>}</>}
    {direction==='pull'&&<><button className="secondary-button" disabled={working||!github?.authenticated||!repo.trim()||disabled} onClick={()=>void run(async()=>{await beforeAction();setPullResult(null);setPullPreview(await api<PullPreview>('/api/github/pull/preview',destination()));})}><Download size={15}/>预览仓库中的笔记</button>
      {pullPreview&&<div className="pull-preview"><p>{pullPreview.repo} · {pullPreview.branch} · {pullPreview.items.length} 篇</p>{pullPreview.items.map(item=><details key={item.id} open={item.status==='conflict'}><summary>{item.title} · {{add:'新增到本机',update:'更新本机',conflict:'两边都有修改，保留本机副本',unchanged:'内容一致',local:'只有本机有修改，保留本机'}[item.status]}</summary>{item.warnings.map(w=><p key={w}>{w}</p>)}{item.localHtml&&item.status==='conflict'&&<><h4>本机内容（将保留副本）</h4><div className="document-editor" dangerouslySetInnerHTML={{__html:item.localHtml}}/></>}<h4>远端内容</h4><div className="document-editor" dangerouslySetInnerHTML={{__html:item.html}}/></details>)}
      {!pullResult&&<button className="primary-button" disabled={working||disabled} onClick={()=>void run(async()=>{await beforeAction();const value=await api<{notes:Note[];backups:Note[]}>('/api/github/pull',{previewId:pullPreview.previewId});setPullResult(value);const current=value.notes.find(n=>n.id===note?.id)||value.notes[0];if(current)onNote(current);})}>确认拉取{pullPreview.items.some(n=>n.status==='conflict')?'并保留冲突副本':''}</button>}</div>}
      {pullResult&&<div className="login-state"><p><Check size={15}/>已检查 {pullResult.notes.length} 篇笔记，保留 {pullResult.backups.length} 份本机冲突副本。文档库已更新。</p></div>}
    </>}

   </>}
  </section></div>}
 </>;
}
