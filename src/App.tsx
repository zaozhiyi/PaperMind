import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, Plus, Sparkles, FileText, Settings, PanelLeftClose, PanelLeft, List, MessageSquare, X, Send, ArrowUpRight, Check, LoaderCircle, Highlighter, Bold, Italic, Heading2, List as ListIcon, Code2, Undo2, ChevronRight, AlertCircle, ArrowDownToLine, RefreshCw, Quote, ExternalLink, Clock3, Table2, Maximize2, Minimize2, Minus, AtSign, SquarePen, Palette, SlidersHorizontal, MoreHorizontal, Download, Github, Link2 } from 'lucide-react';
import { api, stream } from './api';
import { ThemeSettings, useAppearance } from './ThemeSettings';
import { DocumentLibrary, ArticleOutline, ArticleComments } from './ReaderNavigation';
import { FloatingPanel } from './FloatingPanel';
import { Integrations } from './Integrations';
import { editorExtensions } from '../shared/editor';
import type { AIStatus, Note, NoteSummary, Proposal, Message } from '../shared/types';

type Selection = { from: number; to: number; quote: string; x: number; y: number };
type ChatSummary = { id: string; title: string; updatedAt: string };
type Chat = ChatSummary & { documentId?: string; messages: Message[]; noteIds: string[] };
type Login = { id: string; url?: string; status: string; prompt?: string; error?: string };
function AssistantText({ text }: { text: string }) {
  return <div className="assistant-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>, img: ({ alt }) => <span className="markdown-image-description">[图片：{alt || '未提供说明'}]</span> }}>{text}</ReactMarkdown></div>;
}
export function App() {
  const [sidebar,setSidebar]=useState(()=>window.innerWidth>850),[commentsOpen,setCommentsOpen]=useState(false);
  const [notes, setNotes] = useState<NoteSummary[]>([]), [note, setNote] = useState<Note | null>(null);
  const [status, setStatus] = useState<AIStatus | null>(null), [error, setError] = useState('');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null), [message, setMessage] = useState(''), [live, setLive] = useState('');
  const [busy, setBusy] = useState(false), [saveState, setSaveState] = useState('saved'), [settings, setSettings] = useState(false);
  const appearance = useAppearance();
  const [chat,setChat]=useState<Chat|null>(null),[chatLoading,setChatLoading]=useState(false);
  const [floating, setFloating] = useState(false), [expanded, setExpanded] = useState(false), [mode, setMode] = useState<'chat'|'thread'>('chat');
  const [floatingPoint, setFloatingPoint] = useState<{x:number;y:number}|null>(null);
  const [streaming, setStreaming] = useState(false);
  const [menu,setMenu]=useState<'document'|null>(null);
  const [integration,setIntegration]=useState<'import'|'github'|null>(null),[formatTools,setFormatTools]=useState(false);
  const [linkEdit,setLinkEdit]=useState<{from:number;to:number;href:string}|null>(null),[linkError,setLinkError]=useState('');
  useEffect(()=>{const outside=(e:PointerEvent)=>{if(!(e.target as Element).closest('[data-menu-root]'))setMenu(null);};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){const opener=document.querySelector<HTMLButtonElement>('[data-menu-root]>button[aria-expanded="true"]');setMenu(null);setLinkEdit(null);setSelection(null);opener?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[]);
  useEffect(()=>{if(menu)document.querySelector<HTMLButtonElement>('.menu-panel button:not(:disabled)')?.focus();},[menu]);
  useEffect(()=>{if(!linkEdit&&!settings&&!integration)return;const modal=document.querySelector<HTMLElement>('[aria-modal="true"]');if(!modal)return;const previous=document.activeElement as HTMLElement;const items=()=>Array.from(modal.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')).filter(el=>el.getClientRects().length);const ensureFocus=()=>{if(modal.isConnected&&!modal.contains(document.activeElement))(items()[0]||modal).focus();};ensureFocus();const observer=new MutationObserver(ensureFocus);observer.observe(modal,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled']});const trap=(e:KeyboardEvent)=>{if(e.key!=='Tab')return;const list=items(),first=list[0],last=list.at(-1);if(!first){e.preventDefault();return;}if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}};modal.addEventListener('keydown',trap);return()=>{observer.disconnect();modal.removeEventListener('keydown',trap);if(previous.isConnected)previous.focus();else document.querySelector<HTMLButtonElement>('[aria-label="文档菜单"]')?.focus();};},[!!linkEdit,settings,integration]);
  useEffect(()=>{const hide=()=>setSelection(null);window.addEventListener('resize',hide);const reading=document.querySelector('.reading-scroll');reading?.addEventListener('scroll',hide);return()=>{window.removeEventListener('resize',hide);reading?.removeEventListener('scroll',hide);};},[]);

  const [login, setLogin] = useState<Login | null>(null), [loginInput, setLoginInput] = useState('');
  const [headings, setHeadings] = useState<{ text: string; pos: number; level: number }[]>([]);
  const current = useRef<Note | null>(null), dirty = useRef(false), changes = useRef(0), saving = useRef<Promise<void> | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null), titleRef = useRef('');
  const actionLock = useRef(false);
  const flushRef = useRef<() => Promise<void>>(async () => {}), openThread = useRef<(id: string) => void>(() => {}), conversationEnd = useRef<HTMLDivElement>(null);
  const refreshHeadings = (ed: any) => { const items: {text: string; pos: number; level: number}[] = []; ed.state.doc.descendants((node: any, pos: number) => { if (node.type.name === 'heading') items.push({ text: node.textContent, pos, level: node.attrs.level }); }); setHeadings(items); };
  const markDirty = () => { dirty.current = true; changes.current++; setSaveState('unsaved'); if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => flushRef.current().catch(() => {}), 700); };
  const editor = useEditor({
    extensions: [...editorExtensions(), Placeholder.configure({ placeholder: '从一个问题开始，也可以直接写下你的想法…' })],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    editorProps: { attributes: { 'aria-label': '文档正文', class: 'document-editor' }, handleClick: (_view, _pos, event) => { const el = (event.target as HTMLElement).closest('[data-thread-ids]'); if (el) { const id = el.getAttribute('data-thread-ids')?.split(' ')[0]; if (id) openThread.current(id); } return false; } },
    onUpdate: ({ editor: ed }) => { markDirty(); refreshHeadings(ed); },
    onSelectionUpdate: ({ editor: ed }) => { requestAnimationFrame(()=>{
      if(ed.isDestroyed)return;
      const {from,to}=ed.state.selection;if(from===to){setSelection(null);return;}
      const native=window.getSelection();const range=native?.rangeCount?native.getRangeAt(0):null;
      const rect=range&&ed.view.dom.contains(range.commonAncestorContainer)?range.getBoundingClientRect():ed.view.coordsAtPos(from);
      setSelection({from,to,quote:ed.state.doc.textBetween(from,to,'\n'),x:Math.max(116,Math.min((rect.left+rect.right)/2,window.innerWidth-116)),y:Math.max(66,rect.top-46)});
    }); },
  });
  const updateSummary = useCallback((n: Note) => setNotes(prev => { const summary={ id: n.id, title: n.title, revision: n.revision, updatedAt: n.updatedAt }; return prev.some(item=>item.id===n.id)?prev.map(item=>item.id===n.id?summary:item):[...prev,summary]; }), []);
  const accept = useCallback((n: Note, replaceContent = true) => { current.current = n; titleRef.current = n.title; setNote(n); updateSummary(n); if (replaceContent && editor) { editor.commands.setContent(n.content, { emitUpdate: false }); refreshHeadings(editor); dirty.current = false; setSaveState('saved'); setSelection(null); } }, [editor, updateSummary]);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (saving.current) await saving.current;
    if (!dirty.current || !current.current || !editor) return;
    const task = (async () => { while (dirty.current && current.current) { setSaveState('saving'); const v = changes.current, n = current.current; const content = editor.getJSON(); const saved = await api<Note>(`/api/notes/${n.id}`, { revision: n.revision, title: titleRef.current, content }, 'PUT'); current.current = saved; updateSummary(saved); setNote(prev => prev?.id === saved.id ? { ...saved, title: titleRef.current, content: editor.getJSON() } : prev); dirty.current = changes.current !== v; } setSaveState('saved'); })();
    saving.current = task;
    try { await task; } catch (e) { setSaveState('error'); setError(String((e as Error).message)); throw e; } finally { saving.current = null; }
  }, [editor, updateSummary]);
  flushRef.current = flush;
  openThread.current = id => { if(actionLock.current)return; setCommentsOpen(false); setThreadId(id); setMode('thread'); setFloating(true); setFloatingPoint(null); setSelection(null); setMessage(''); setMenu(null); };
  useEffect(() => { if (!editor) return; let disposed = false; (async () => { const [items, ai] = await Promise.all([api<NoteSummary[]>('/api/notes'), api<AIStatus>('/api/ai/status')]); if (disposed) return; setNotes(items); setStatus(ai); const previous = new URLSearchParams(location.search).get('note')||localStorage.getItem('yejian-note'); const first = items.find(n => n.id === previous) || items[0]; if (first) accept(await api<Note>(`/api/notes/${first.id}`)); })().catch(e => !disposed && setError(e.message)); return () => { disposed = true; }; }, [editor]);
  useEffect(()=>{if(!editor)return;let disposed=false;const refresh=async()=>{if(disposed||document.hidden||actionLock.current||dirty.current||saving.current)return;try{const items=await api<NoteSummary[]>('/api/notes');if(disposed)return;setNotes(items);const id=current.current?.id;if(id){const fresh=await api<Note>(`/api/notes/${id}`);if(!disposed&&!actionLock.current&&!dirty.current&&!saving.current&&current.current?.id===id&&JSON.stringify(fresh)!==JSON.stringify(current.current)){accept(fresh);const updatedChat=await api<Chat|null>(`/api/notes/${id}/chat`);if(!disposed&&!actionLock.current&&current.current?.id===id)setChat(updatedChat);}}}catch{/* Offline work remains visible; explicit writes report failures. */}};const timer=setInterval(refresh,3000);window.addEventListener('focus',refresh);return()=>{disposed=true;clearInterval(timer);window.removeEventListener('focus',refresh);};},[editor,accept]);
  useEffect(()=>{setChat(null);if(!note?.id)return;let cancelled=false;setChatLoading(true);api<Chat|null>(`/api/notes/${note.id}/chat`).then(value=>{if(!cancelled)setChat(value);}).catch(e=>{if(!cancelled)setError(e.message);}).finally(()=>{if(!cancelled)setChatLoading(false);});return()=>{cancelled=true;};},[note?.id]);
  useEffect(() => { if(note){localStorage.setItem('yejian-note',note.id);const url=new URL(location.href);url.searchParams.set('note',note.id);window.history.replaceState(null,'',url);} }, [note?.id]);
  useEffect(() => { editor?.setEditable(!busy, false); }, [editor, busy]);
  useEffect(() => { const protect = (e: BeforeUnloadEvent) => { if (dirty.current || busy) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect); }, [busy]);
  useEffect(() => { conversationEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [live, note?.threads, threadId, chat?.messages, floating]);
  useEffect(() => { if (!login || login.status !== 'pending') return; const interval = setInterval(() => { api<Login>(`/api/ai/login/${login.id}`).then(data => { setLogin(data); if (data.status === 'complete') api<AIStatus>('/api/ai/status').then(setStatus); }).catch(e => setError(e.message)); }, 1800); return () => clearInterval(interval); }, [login?.id, login?.status]);
  const run = async (fn: () => Promise<void>) => { setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } };
  const exclusive = async (fn: () => Promise<void>) => { if (actionLock.current) return; actionLock.current = true; setBusy(true); try { await fn(); } finally { actionLock.current = false; setBusy(false); } };
  const closeSettings = () => run(async () => { if (login?.status === 'pending') { await api(`/api/ai/login/${login.id}/cancel`, {}); setLogin(null); } setSettings(false); });
  useEffect(()=>{if(!settings)return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')closeSettings();};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[settings,login?.id,login?.status]);
  const switchNote = (id: string) => run(() => exclusive(async () => { await flush(); accept(await api<Note>(`/api/notes/${id}`)); setThreadId(null);setMode('chat');setFloating(false);setMessage(''); }));
  const newNote = () => run(() => exclusive(async () => { await flush(); const n = await api<Note>('/api/notes', { title: '未命名文档' }); accept(n); setThreadId(null);setMode('chat');setFloating(false);setMessage(''); }));
  const startThread = () => run(() => exclusive(async () => { if (!selection || !current.current) return; const sel = selection; await flush(); const result = await api<{note: Note; threadId: string}>(`/api/notes/${current.current.id}/threads`, { revision: current.current.revision, from: sel.from, to: sel.to, quote: sel.quote }); accept(result.note); setThreadId(result.threadId); setMode('thread'); setFloating(true); setExpanded(false); setFloatingPoint({x: Math.max(16, Math.min(sel.x + 20, window.innerWidth - 378)), y: Math.max(76, Math.min(sel.y + 55, window.innerHeight - 405))}); setMessage(''); }));
  const send = (mode: 'chat' | 'writeback') => run(() => exclusive(async () => { if (!current.current || !threadId || (!message.trim() && mode === 'chat')) return; if (!status?.configured) { setSettings(true); return; } await flush(); const text = message.trim() || '把本次讨论的要点补充到选中的正文中，保持上下文连贯。'; setStreaming(true); setLive(''); setMessage(''); const pendingNote = current.current; setNote({ ...pendingNote, threads: pendingNote.threads.map(t => t.id === threadId ? { ...t, messages: [...t.messages, {id: 'pending', role: 'user', text, createdAt: new Date().toISOString()}] } : t) }); try { await stream(`/api/notes/${pendingNote.id}/threads/${threadId}/message`, { text, mode }, (type, value) => { if (type === 'text') setLive(v => v + value.delta); if (type === 'done') accept(value.note); }); } catch (e) { setMessage(text); const restored = await api<Note>(`/api/notes/${pendingNote.id}`).catch(() => null); if (restored) accept(restored); throw e; } finally { setLive(''); setStreaming(false); } }));
  const apply = (proposal: Proposal) => run(() => exclusive(async () => { await flush(); if (!current.current) return; accept(await api<Note>(`/api/notes/${current.current.id}/proposals/${proposal.id}/apply`, {revision: current.current.revision})); }));
  const undo = (proposalId: string) => run(() => exclusive(async () => { await flush(); if (!current.current) return; accept(await api<Note>(`/api/notes/${current.current.id}/undo`, { revision: current.current.revision, proposalId })); }));
  const acceptChat=(value:Chat)=>setChat(value);
  const openDocumentChat=()=>{if(actionLock.current)return;setMode('chat');setThreadId(null);setMessage('');setFloating(true);setFloatingPoint(null);setSelection(null);setCommentsOpen(false);};
  const closeFloating=()=>{setFloating(false);setMenu(null);};
  const sendChat = () => run(()=>exclusive(async()=>{
    const text=message.trim();if(!text||chatLoading||!current.current)return;if(!status?.configured){setSettings(true);return;}await flush();
    let active=chat;if(!active||active.documentId!==current.current.id){active=await api<Chat>(`/api/notes/${current.current.id}/chat`,{});acceptChat(active);}
    const activeId=active.id;setStreaming(true);setLive('');setMessage('');
    acceptChat({...active,messages:[...active.messages,{id:'pending',role:'user',text,createdAt:new Date().toISOString()}]});
    try {await stream(`/api/chats/${activeId}/message`,{text,noteId:current.current.id},(type,value)=>{
      if(type==='text')setLive(v=>v+value.delta);

      if(type==='done'){if(value.chat)acceptChat(value.chat);}
    });}catch(e){setMessage(text);const restored=await api<Chat>(`/api/chats/${activeId}`).catch(()=>null);if(restored)acceptChat(restored);throw e;}finally{setLive('');setStreaming(false);}
  }));
  const thread = note?.threads.find(t => t.id === threadId);
  const formatButton = (label: string, icon: React.ReactNode, action: () => void, active = false) => <button className={`icon-button ${active ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={active} disabled={busy} onMouseDown={e => e.preventDefault()} onClick={action}>{icon}</button>;
  const visibleMessages = mode === 'thread' ? thread?.messages || [] : chat?.messages || [];
  const submitMessage = () => mode === 'thread' ? send('chat') : sendChat();
  const jumpHeading=(pos:number)=>{const dom=editor?.view.domAtPos(pos+1).node;(dom instanceof HTMLElement?dom:dom?.parentElement)?.scrollIntoView({behavior:'smooth',block:'start'});};
  const jumpThread=(id:string)=>{openThread.current(id);editor?.view.dom.querySelector(`[data-thread-ids~="${id}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});};
  return <div className="app">
    {sidebar&&<DocumentLibrary notes={notes} note={note} busy={busy} onNote={id=>{switchNote(id);setCommentsOpen(false);if(window.innerWidth<=850)setSidebar(false);}} onNew={newNote} onClose={()=>setSidebar(false)} onSettings={()=>{setSelection(null);setSettings(true);}}/>}
    <div className="workspace"><header className="topbar"><div className="breadcrumbs">{!sidebar&&<button className="icon-button" aria-label="展开文档库" onClick={()=>setSidebar(true)}><PanelLeft size={18}/></button>}<span>文档</span><ChevronRight size={12}/><strong>{note?.title || '未命名文档'}</strong></div><div className="topbar-actions"><button className="icon-button" aria-label="当前文章批注" title="批注与讨论" aria-expanded={commentsOpen} onClick={()=>setCommentsOpen(!commentsOpen)}><MessageSquare size={17}/></button><span className={`save-indicator ${saveState}`} title={saveState==='saved'?'已保存':saveState==='saving'?'保存中':saveState==='error'?'保存失败':'等待保存'} aria-live="polite">{saveState === 'saving' ? <LoaderCircle size={12} className="spin"/> : saveState === 'error' ? <AlertCircle size={12}/> : <Check size={12}/>} {saveState === 'saved' ? '已保存' : saveState === 'saving' ? '保存中' : saveState === 'error' ? '保存失败' : '等待保存'}</span><div className="menu-root" data-menu-root><button className="icon-button" aria-label="文档菜单" title="文档菜单" aria-expanded={menu==='document'} onClick={()=>{setMenu(menu==='document'?null:'document');setSelection(null);}}><MoreHorizontal size={19}/></button>{menu==='document'&&<div className="menu-panel" role="group" aria-label="文档操作">
        <button disabled={busy} onClick={()=>{setMenu(null);setFormatTools(!formatTools);}}><Bold size={15}/>{formatTools?'收起格式工具栏':'格式工具栏'}</button>
        <div className="menu-divider"/>
        <button disabled={busy} onClick={()=>{setMenu(null);setIntegration('import');}}><Download size={15}/>导入网页</button>
        <button disabled={busy||!note} onClick={()=>{setMenu(null);setIntegration('github');}}><Github size={15}/>同步到 GitHub</button>
      </div>}</div><button className={`topbar-ai ${floating?'active':''}`} aria-label="讨论当前文章" title="讨论当前文章" disabled={busy||!note} aria-expanded={floating&&mode==='chat'} onClick={()=>{if(floating&&mode==='chat')closeFloating();else openDocumentChat();}}><AtSign size={16}/>AI{streaming&&<span className="capsule-dot"/>}</button></div></header>
      {error && <div className="error-banner" role="alert"><AlertCircle size={16}/><span>{error}</span>{saveState === 'error' && <button onClick={() => run(flush)}>重试保存</button>}<button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={14}/></button></div>}
      <div className="reading-layout"><ArticleOutline title={note?.title||''} noteId={note?.id} headings={headings} onHeading={jumpHeading}/><main className="reading-scroll"><article className="document" key={note?.id || 'empty'}>
        <input className="document-title" aria-label="文档标题" value={note?.title || ''} disabled={!note || busy} placeholder="未命名文档" onChange={e => { titleRef.current = e.target.value; setNote(n => n ? {...n, title: e.target.value} : n); markDirty(); }}/>
        <div className="document-meta"><span>{note ? new Date(note.updatedAt).toLocaleDateString('zh-CN', {month:'long', day:'numeric'}) : '今天'}</span><span>·</span><span>{editor?.getText().replace(/\s/g, '').length || 0} 字</span>{note?.sourceUrl&&<a href={note.sourceUrl} target="_blank" rel="noreferrer">查看来源<ArrowUpRight size={11}/></a>}</div>
        {formatTools&&<div className="editor-toolbar" role="toolbar" aria-label="文档格式工具栏">
          {formatButton('二级标题', <Heading2 size={17}/>, () => editor?.chain().focus().toggleHeading({level:2}).run(), editor?.isActive('heading', {level:2}))}
          <span className="toolbar-divider"/>{formatButton('加粗', <Bold size={16}/>, () => editor?.chain().focus().toggleBold().run(), editor?.isActive('bold'))}{formatButton('斜体', <Italic size={16}/>, () => editor?.chain().focus().toggleItalic().run(), editor?.isActive('italic'))}{formatButton('黄色高亮', <Highlighter size={17}/>, () => editor?.chain().focus().toggleHighlight({color:'#fff0a8'}).run(), editor?.isActive('highlight'))}<span className="toolbar-divider"/>{formatButton('无序列表', <ListIcon size={17}/>, () => editor?.chain().focus().toggleBulletList().run())}{formatButton('引用', <Quote size={16}/>, () => editor?.chain().focus().toggleBlockquote().run())}{formatButton('代码块', <Code2 size={17}/>, () => editor?.chain().focus().toggleCodeBlock().run())}{formatButton('插入表格', <Table2 size={16}/>, () => editor?.chain().focus().insertTable({rows:3,cols:3,withHeaderRow:true}).run())}<span className="toolbar-divider"/>{formatButton('撤销编辑', <Undo2 size={16}/>, () => editor?.chain().focus().undo().run())}
        </div>}<EditorContent editor={editor}/>
      </article></main>{commentsOpen&&<ArticleComments note={note} busy={busy} onThread={jumpThread} onClose={()=>setCommentsOpen(false)}/>}
      </div>
    </div>
    {floating && <FloatingPanel expanded={expanded} point={floatingPoint} onPoint={setFloatingPoint}>
      <div className="float-header"><strong tabIndex={0} aria-label="移动讨论窗口，可拖动或用方向键" title="拖动移动 · 方向键微调">{mode==='thread'?'这段文字的讨论':'这篇文章的讨论'}</strong><div className="float-controls"><button className="icon-button" aria-label={expanded?'缩小讨论窗口':'放大讨论窗口'} title={expanded?'缩小':'放大'} onClick={()=>{setExpanded(!expanded);setFloatingPoint(null);}}>{expanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button><button className="icon-button" aria-label="关闭讨论窗口" title="关闭，讨论会保留" onClick={closeFloating}><X size={17}/></button></div></div>
      {mode==='chat'&&note&&<div className="document-context" title={note.title}><FileText size={13}/><span>{note.title}</span></div>}
      {mode==='thread'&&thread&&<div className="thread-quote"><p title={thread.quote.trim()}>{thread.quote.trim()}</p>{thread.detached&&<small>原文已变化，讨论仍然保留。</small>}</div>}
      <div className="messages">{!visibleMessages.length&&!streaming&&<div className="conversation-empty"><p>{mode==='thread'?'围绕选中的文字提问。':chatLoading?'正在读取这篇文章的讨论…':'围绕这篇文章提问，讨论会保存在这里。'}</p></div>}
        {visibleMessages.map(m=><div className={`message ${m.role}`} key={m.id}><div className="message-label">{m.role==='assistant'?'AI':'你'}</div><div className="message-text">{m.role==='assistant'?<AssistantText text={m.text}/>:m.text}</div></div>)}
        {streaming&&<div className="message assistant"><div className="message-label"><LoaderCircle size={12} className="spin"/>正在回复</div><div className="message-text">{live?<AssistantText text={live}/>:<span className="thinking-dots">…</span>}</div></div>}
        {mode==='thread'&&thread?.proposals.map(p=><div className={`proposal ${p.state}`} key={p.id}><details open={p.state==='pending'}><summary className="proposal-title">{p.state==='applied'?'已写回正文':p.state==='undone'?'已撤销这次修改':'修改建议'}</summary><p>{p.explanation}</p><div className="proposal-original"><small>原文</small>{p.original}</div><div className="proposal-replacement"><small>替换为</small><div dangerouslySetInnerHTML={{__html:p.replacementHtml}}/></div>{p.state==='pending'&&<button className="primary-button" disabled={busy||thread.detached} onClick={()=>apply(p)}><ArrowDownToLine size={14}/>应用到正文</button>}</details>{p.state==='applied'&&p.canUndo!==false&&<button className="text-button" disabled={busy} onClick={()=>undo(p.id)}><Undo2 size={13}/>撤销这次 AI 修改</button>}</div>)}
        <div ref={conversationEnd}/>
      </div>
      <div className="composer"><textarea aria-label="向 AI 提问" placeholder={mode==='thread'?'问问这段文字…':'问问这篇文章…'} value={message} onChange={e=>setMessage(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();submitMessage();}}} disabled={busy}/><div className="composer-actions">{mode==='thread'&&!!thread?.messages.length?<button className="writeback-button" disabled={busy||thread?.detached} title="根据本次讨论补充、完善选中段落，直接保存，完成后可撤销" onClick={()=>send('writeback')}><ArrowDownToLine size={13}/>讨论融入正文</button>:!status?.configured?<button className="model-chip" onClick={()=>setSettings(true)}>连接 AI<ChevronRight size={11}/></button>:<span/>}<button className="send-button" aria-label="发送问题" disabled={busy||!message.trim()||(mode==='chat'&&chatLoading)} onClick={submitMessage}>{streaming?<LoaderCircle className="spin" size={16}/>:<Send size={15}/>}</button></div></div>
    </FloatingPanel>}
    {selection&&!busy&&!settings&&!integration&&!linkEdit&&!menu&&<div className="selection-popover" role="toolbar" aria-label="选中文字工具" style={{left:selection.x,top:selection.y}} onMouseDown={e=>e.preventDefault()}>
      {formatButton('选中文字加粗',<Bold size={15}/>,()=>editor?.chain().focus().setTextSelection(selection).toggleBold().run(),editor?.isActive('bold'))}
      {formatButton('选中文字斜体',<Italic size={15}/>,()=>editor?.chain().focus().setTextSelection(selection).toggleItalic().run(),editor?.isActive('italic'))}
      {formatButton('高亮选中文字',<Highlighter size={15}/>,()=>editor?.chain().focus().setTextSelection(selection).toggleHighlight({color:'#fff0a8'}).run(),editor?.isActive('highlight'))}
      {formatButton('编辑链接',<Link2 size={15}/>,()=>{setLinkError('');setLinkEdit({from:selection.from,to:selection.to,href:editor?.getAttributes('link').href||''});},editor?.isActive('link'))}
      <span/><button onClick={startThread} aria-label="问 AI"><AtSign size={14}/>问 AI</button>
    </div>}
    <Integrations note={note} mode={integration} onClose={()=>setIntegration(null)} onNote={n=>{accept(n);setThreadId(null);setMode('chat');setFloating(false);}} beforeAction={flush} disabled={busy}/>
    {linkEdit&&<div className="modal-backdrop"><form className="modal link-modal" role="dialog" aria-modal="true" tabIndex={-1} aria-label="编辑链接" onSubmit={e=>{e.preventDefault();let href=linkEdit.href.trim();if(href&&!/^(https?:\/\/|mailto:)/i.test(href)){setLinkError('请输入 http://、https:// 或 mailto: 开头的链接。');return;}const chain=editor?.chain().focus().setTextSelection({from:linkEdit.from,to:linkEdit.to});if(href)chain?.setLink({href}).run();else chain?.unsetLink().run();setLinkEdit(null);setSelection(null);}}><button type="button" className="modal-close icon-button" aria-label="关闭链接编辑" onClick={()=>setLinkEdit(null)}><X size={18}/></button><h2>编辑链接</h2><label className="field-label">链接地址<input autoFocus aria-label="链接地址" placeholder="https://" value={linkEdit.href} onChange={e=>setLinkEdit({...linkEdit,href:e.target.value})}/></label>{linkError&&<p role="alert">{linkError}</p>}<div className="link-actions"><button type="button" className="text-button" onClick={()=>{editor?.chain().focus().setTextSelection({from:linkEdit.from,to:linkEdit.to}).unsetLink().run();setLinkEdit(null);setSelection(null);}}>移除链接</button><button type="submit" className="primary-button">保存链接</button></div></form></div>}
    {settings && <div className="modal-backdrop"><section className="modal settings-modal" role="dialog" aria-modal="true" tabIndex={-1} aria-label="AI 连接设置"><button className="modal-close icon-button" aria-label="关闭设置" onClick={closeSettings}><X size={19}/></button>{error && <div className="modal-error" role="alert"><AlertCircle size={15}/>{error}</div>}<h2>设置</h2><ThemeSettings {...appearance}/><h3 className="settings-section-title">AI 连接</h3><p>文档与讨论保存在本机。发起 AI 请求时，相关正文和讨论会交给你选择的模型。</p><div className="provider-card"><div className="provider-logo"><Sparkles size={22}/></div><div><strong>ChatGPT</strong><small>{status?.configured ? '已连接 · 凭据仅保存在本机' : '通过 Pi 连接你授权的模型额度'}</small></div>{status?.configured && <Check size={18} className="connected-check"/>}</div>
      {status?.configured && <label className="field-label">当前模型<select aria-label="选择模型" value={status.model} onChange={e => run(async()=>{ await api('/api/ai/model',{model:e.target.value}); setStatus(await api<AIStatus>('/api/ai/status')); })}>{status.models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
      <button className="primary-button full" onClick={()=>run(async()=>{if (login?.status === 'pending') await api(`/api/ai/login/${login.id}/cancel`, {}); setLogin(await api<Login>('/api/ai/login',{}));})}><ExternalLink size={16}/>{status?.configured ? '重新连接账号' : '登录 ChatGPT 账号'}</button>
      {login && <div className="login-state">{login.status==='pending' && <><p><LoaderCircle size={14} className="spin"/>等待完成账号授权</p>{login.url && <a className="auth-link" href={login.url} target="_blank" rel="noreferrer">打开授权页面 <ArrowUpRight size={14}/></a>}<button className="text-button" onClick={()=>run(async()=>{await api(`/api/ai/login/${login.id}/cancel`,{}); setLogin(null);})}>取消本次登录</button>{login.prompt && <><label className="field-label">{login.prompt}<input aria-label="授权验证码或回调地址" value={loginInput} onChange={e=>setLoginInput(e.target.value)}/></label><button className="secondary-button" onClick={()=>run(async()=>{await api(`/api/ai/login/${login.id}/input`,{value:loginInput}); setLoginInput('');})}>提交授权信息</button></>}</>}{login.status==='complete' && <p><Check size={16}/>连接完成，现在可以开始共同写作。</p>}{login.status==='error' && <p className="login-error">{login.error || '登录失败，请重试。'}</p>}</div>}
      <button className="text-button refresh-status" onClick={()=>run(async()=>setStatus(await api<AIStatus>('/api/ai/status')))}><RefreshCw size={13}/>刷新连接状态</button>
    </section></div>}
  </div>;
}
