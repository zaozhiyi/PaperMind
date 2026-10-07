import express from 'express';
import { createKnowledgeSync, installKnowledgeRoutes, knowledgeConfig, assertPrivateOwner } from './knowledge-sync.ts';
import { githubCLI } from './integrations.ts';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { DocumentStore, AppError, toHTML, fromHTML, threadRange, validateContent } from './documents.ts';
import type { Note } from '../shared/types.ts';
import { createAIService, AIError, type AIService } from './ai.ts';
import { installAgentRoutes } from './transfer.ts';
import { installChatRoutes } from './chats.ts';
import { installIntegrationRoutes, type IntegrationDependencies } from './integrations.ts';

export async function createApp(dataDir:string, dependencies: { ai?: AIService; integrations?: IntegrationDependencies } = {}) {
  const app=express();const store=new DocumentStore(dataDir);const ai=dependencies.ai||await createAIService(dataDir);
  const sessionToken=randomBytes(32).toString('hex');
  const busy = new Set<string>();
  app.disable('x-powered-by');app.use(express.json({limit:'3mb'}));
  app.use('/api',(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    const hostname=req.hostname;
    if(!['127.0.0.1','localhost','::1'].includes(hostname)){res.status(403).json({message:'仅允许本机访问。'});return;}
    const origin=req.headers.origin;
    if(origin&&origin!==`${req.protocol}://${req.headers.host}`){res.status(403).json({message:'来源不受信任。'});return;}
    if(!['GET','HEAD'].includes(req.method)&&req.headers['x-study-token']!==sessionToken){res.status(403).json({message:'会话已过期，请刷新页面。'});return;}
    next();
  });
  app.get('/api/session',(_req,res)=>res.json({token:sessionToken}));
  app.get('/api/health',(_req,res)=>res.json({ok:true,app:'papermind',version:'0.4.0',pid:process.pid}));
  app.get('/api/notes',(_req,res)=>res.json(store.list()));
  app.post('/api/notes',(req,res)=>{
    const {title}=z.object({title:z.string().max(200).default('未命名文档')}).parse(req.body);
    res.status(201).json(store.create(title));
  });
  const modelStatus=()=>{const status=ai.status();return {...status,configured:status.ready,models:status.models.filter(m=>m.provider===status.provider)};};
  app.get('/api/ai/status',(_req,res)=>res.json(modelStatus()));
  const loginDTO=(s:any)=>({...s,status:s.status==='complete'?'complete':s.status==='failed'||s.status==='cancelled'?'error':'pending'});
  app.post('/api/ai/login',async(_req,res)=>{res.json(loginDTO(await ai.startLogin()));});
  app.get('/api/ai/login/:id',(req,res)=>res.json(loginDTO(ai.loginState(req.params.id))));
  app.post('/api/ai/login/:id/input',async(req,res)=>{const {value}=z.object({value:z.string().min(1).max(8000)}).parse(req.body);res.json(loginDTO(await ai.submitLoginInput(req.params.id,value)));});
  app.post('/api/ai/login/:id/cancel',(req,res)=>res.json(loginDTO(ai.cancelLogin(req.params.id))));
  app.post('/api/ai/model',async(req,res)=>{const {model}=z.object({model:z.string().min(1).max(100)}).parse(req.body);await ai.configure({model});res.json(modelStatus());});
  function stream(res:express.Response) {
    res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const controller=new AbortController();res.on('close',()=>controller.abort());
    const send=(event:string,data:unknown)=>{if(!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
    const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keepalive\n\n');},15000);
    const end=()=>{clearInterval(heartbeat);res.end();};
    return {send,end,signal:controller.signal};
  }
  app.post('/api/notes/generate',async(req,res)=>{
    const {prompt}=z.object({prompt:z.string().trim().min(1).max(12000)}).parse(req.body);
    if(!ai.status().ready)throw new AppError(409,'请先在「连接模型」中登录 ChatGPT，再让 AI 写文档。');
    if(busy.has('create'))throw new AppError(409,'另一篇文档正在生成，请稍候。');
    busy.add('create');const {send,end,signal}=stream(res);let created:Note|undefined;
    try{
      await ai.run({mode:'create',messages:[{role:'user',content:prompt}],signal,onEvent:e=>{if(e.type==='delta')send('text',{delta:e.text});},tools:{
        createDocument:async({title,html})=>{
          if(created)throw new Error('本次请求已创建文档，请勿重复创建。');
          if(signal.aborted)throw new Error('已取消。');
          const content=fromHTML(html);if(validateContent(content).textContent.length<10)throw new Error('正文太短，请提供完整学习文档。');
          created=store.create(title,content);send('created',{note:created});return {id:created.id,title:created.title,saved:true};
        },
      }});
      if(!created)throw new Error('模型未创建文档，请重试并说明需要生成完整文档。');
      send('done',{note:created});
    }catch(e){send('error',{message:e instanceof Error?e.message:'生成失败',note:created});}finally{busy.delete('create');end();}
  });
  app.get('/api/notes/:id',(req,res)=>res.json(store.get(req.params.id)));
  app.put('/api/notes/:id',(req,res)=>{
    const body=z.object({revision:z.number().int().positive(),title:z.string().max(200),content:z.record(z.string(),z.unknown())}).parse(req.body);
    res.json(store.save(req.params.id,body.revision,body.title,body.content));
  });
  app.post('/api/notes/:id/threads',(req,res)=>{
    const b=z.object({revision:z.number().int().positive(),from:z.number().int(),to:z.number().int(),quote:z.string().min(1).max(30000)}).parse(req.body);
    res.status(201).json(store.addThread(req.params.id,b.revision,b.from,b.to,b.quote));
  });
  app.post('/api/notes/:id/threads/:threadId/message',async(req,res)=>{
    const {text,mode}=z.object({text:z.string().trim().min(1).max(12000),mode:z.enum(['chat','revise','writeback']).default('chat')}).parse(req.body);
    const {id,threadId}=req.params;const key=`${id}:${threadId}`;
    if(busy.has(key))throw new AppError(409,'这条讨论正在回复，请稍候。');
    if(!ai.status().ready)throw new AppError(409,'请先连接模型，讨论和原文会保留。');
    const note=store.get(id),thread=note.threads.find(t=>t.id===threadId);
    if(!thread)throw new AppError(404,'讨论不存在。');
    const range=threadRange(validateContent(note.content),threadId);
    if((mode==='revise'||mode==='writeback')&&!range)throw new AppError(409,'原文已删除，不能直接写回；讨论仍然保留。');
    busy.add(key);store.addMessage(id,threadId,'user',text);
    const {send,end,signal}=stream(res);let partial='';let hasProposal=false;
    try{
      const result=await ai.run({mode,context:{document:{id,title:note.title,html:toHTML(note.content),revision:note.revision},selection:{text:range?.text||thread.quote,from:range?.from,to:range?.to},threadId},
        messages:[...thread.messages.map(m=>({role:m.role,content:m.text})),{role:'user',content:text}],signal,
        onEvent:e=>{if(e.type==='delta'){partial+=e.text;send('text',{delta:e.text});}},
        tools:{readDocument:async()=>{const current=store.get(id);return {title:current.title,html:toHTML(current.content),revision:current.revision};},
          ...((mode==='revise'||mode==='writeback')?{proposeEdit:async({replacement,explanation}:{replacement:string;explanation:string})=>{
            if(signal.aborted)throw new Error('已取消。');
            if(hasProposal)throw new Error('本轮已有一条修改建议。');
            if(mode==='writeback'){
              const saved=store.writeback(id,threadId,note.revision,range!.text,replacement,explanation);
              hasProposal=true;const p=saved.threads.find(t=>t.id===threadId)!.proposals.at(-1)!;
              send('proposal',p);return {proposalId:p.id,state:'applied',revision:saved.revision};
            }
            const p=store.propose(id,threadId,note.revision,range!.text,replacement,explanation);hasProposal=true;send('proposal',p);return {proposalId:p.id,state:'awaiting_user_apply'};
          }}:{}),
        },
      });
      if(result.text.trim())store.addMessage(id,threadId,'assistant',result.text);
      if((mode==='revise'||mode==='writeback')&&!hasProposal)send('error',{message:'模型没有生成可应用的修改建议，可以在讨论中补充要求后重试。'});
      send('done',{note:store.get(id)});
    }catch(e){
      if(partial.trim())store.addMessage(id,threadId,'assistant',`${partial}\n\n[本次回复中断，以上为已收到的内容。]`);
      send('error',{message:e instanceof Error?e.message:'模型请求失败'});send('done',{note:store.get(id)});
    }finally{busy.delete(key);end();}
  });
  app.post('/api/notes/:id/proposals/:proposalId/apply',(req,res)=>{const {revision}=z.object({revision:z.number().int().positive()}).parse(req.body);res.json(store.apply(req.params.id,req.params.proposalId,revision));});
  app.post('/api/notes/:id/undo',(req,res)=>{const {revision,proposalId}=z.object({revision:z.number().int().positive(),proposalId:z.string().uuid().optional()}).parse(req.body);res.json(store.undo(req.params.id,revision,proposalId));});
  installAgentRoutes(app,store);
  installChatRoutes(app,store,ai);
  const github=dependencies.integrations?.github||githubCLI();
  const integrations=await installIntegrationRoutes(app,store,dataDir,{...dependencies.integrations,github,beforePush:async(repo)=>{
    const config=knowledgeConfig(store);
    if(config){if(repo.toLowerCase()!==config.repo.toLowerCase())throw new AppError(403,'已绑定私有知识库，请勿将学习笔记上传到其他仓库。');await assertPrivateOwner(github,repo);}
    await dependencies.integrations?.beforePush?.(repo);
  }});
  const knowledge=createKnowledgeSync(store,integrations,github);installKnowledgeRoutes(app,knowledge);
  app.use('/api',(_req,res)=>res.status(404).json({message:'接口不存在。'}));
  app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(res.headersSent){res.end();return;}
    const status=err instanceof AppError||err instanceof AIError?err.status:err instanceof z.ZodError?400:500;
    res.status(status).json({message:err instanceof z.ZodError?'输入格式不正确。':err instanceof Error?err.message:'服务暂时不可用。'});
  });
  return {app,store,ai,knowledge};
}
