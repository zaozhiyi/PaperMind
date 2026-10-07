import {useEffect,useState} from 'react';
import {api} from './api';
type State={config:{repo:string;branch:string;folder:string;enabled:boolean;excludedIds:string[]}|null;busy:boolean;lastSuccess:string|null;error:string|null};
export function KnowledgeSync(){
 const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[working,setWorking]=useState(false);
 const refresh=()=>api<State>('/api/knowledge/status').then(setState).catch(()=>{});
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[]);
 if(!state?.config)return null;
 const c=state.config;
 const act=async(action:'sync'|'pause'|'configure')=>{setWorking(true);setError('');try{await api('/api/knowledge/'+action,action==='configure'?{...c,enabled:true}:{});await refresh();}catch(e){setError(e instanceof Error?e.message:'同步失败');}finally{setWorking(false);}};
 return <div className="login-state"><strong>私有知识库 · {c.repo}</strong><p>{state.busy||working?'正在同步…':c.enabled?'自动同步已开启，每 2 分钟检查一次。':'自动同步已暂停。'}{state.lastSuccess&&` 上次成功：${new Date(state.lastSuccess).toLocaleString()}`}</p>{(state.error||error)&&<p role="alert">{error||state.error}</p>}<button disabled={working||state.busy||!c.enabled} onClick={()=>void act('sync')}>立即同步</button>{' '}<button disabled={working||state.busy} onClick={()=>void act(c.enabled?'pause':'configure')}>{c.enabled?'暂停自动同步':'恢复自动同步'}</button></div>;
}
