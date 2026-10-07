#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, unlink, open } from 'node:fs/promises';
import { syncCommand } from './sync.mjs';
import { notesCommand } from './notes.mjs';
import { serviceNetworkEnv } from './network.mjs';
const args=process.argv.slice(2);
if(args.includes('--help')||args.includes('-h')){
  console.log('PaperMind\n\n用法: papermind notes list | get ID | import file.md [--id ID --revision N]\n      papermind sync setup owner/repo | status | now | pause\n      papermind [--background] [--port 4317] [--no-open]\n      papermind --status | --stop\n\n--background 在后台持续运行；关闭终端和聊天后仍可访问。\n默认前台运行，Ctrl+C停止。STUDY_DATA_DIR可指定数据目录。');process.exit(0);
}
const i=args.indexOf('--port');const port=i>=0?Number(args[i+1]):Number(process.env.PORT||4317);
if(!Number.isInteger(port)||port<1024||port>65535){console.error('端口应为1024至65535之间的整数。');process.exit(1);}
const root=join(dirname(fileURLToPath(import.meta.url)),'..'),dataDir=process.env.STUDY_DATA_DIR||join(homedir(),'.local','share','study-workbench');
const pidFile=join(dataDir,`service-${port}.json`),url=`http://127.0.0.1:${port}`;
if(['notes','sync'].includes(args[0])){try{await (args[0]==='notes'?notesCommand:syncCommand)(args,url);}catch(e){console.error(e.message==='fetch failed'?'PaperMind未运行，请先启动 papermind --background。':e.message);process.exitCode=1;}process.exit(process.exitCode||0);}
const health=async()=>{try{const r=await fetch(`${url}/api/health`,{signal:AbortSignal.timeout(1500)});if(!r.ok)return null;const j=await r.json();return ['papermind','yejian'].includes(j.app)?j:null;}catch{return null;}};
const openBrowser=()=>{if(args.includes('--no-open')||process.env.STUDY_NO_OPEN==='1')return;const cmd=process.platform==='darwin'?'open':process.platform==='win32'?'explorer':'xdg-open';const p=spawn(cmd,[url],{stdio:'ignore',detached:true});p.on('error',()=>{});p.unref();};
if(args.includes('--status')){const h=await health();console.log(h?`PaperMind运行中：${url}`:'PaperMind未运行。');process.exit(h?0:1);}
if(args.includes('--stop')){
  const h=await health();let record;try{record=JSON.parse(await readFile(pidFile,'utf8'));}catch{}
  if(!h){console.log('PaperMind未运行。');process.exit(0);}
  if(!record||h.pid!==record.pid){console.error('此服务不是由后台命令启动的，请在启动它的终端停止。');process.exit(1);}
  process.kill(record.pid,'SIGTERM');for(let a=0;a<40;a++){await new Promise(r=>setTimeout(r,150));if(!await health()){await unlink(pidFile).catch(()=>{});console.log('PaperMind已停止，文档仍保存在本机。');process.exit(0);}}
  console.error('服务仍在结束请求，请稍后检查状态。');process.exit(1);
}
if(await health()){console.log(`PaperMind已在运行：${url}`);openBrowser();process.exit(0);}
const background=args.includes('--background');await mkdir(dataDir,{recursive:true,mode:0o700});
const log=background?await open(join(dataDir,'server.log'),'a',0o600):null;
const child=spawn(process.execPath,['--import','tsx',join(root,'server','index.ts')],{cwd:root,stdio:log?['ignore',log.fd,log.fd]:'inherit',detached:background,env:{...serviceNetworkEnv(),PORT:String(port)}});
await log?.close();let closed=false,started=false;child.on('error',e=>{console.error(e.message);process.exitCode=1;closed=true;});child.on('exit',code=>{
  closed=true;
  if(!started){console.error(`PaperMind启动失败（退出码 ${code??'未知'}），请检查端口是否被占用。日志：${join(dataDir,'server.log')}`);process.exitCode=code||1;}
  if(!background)process.exit(started?(code??0):(code||1));
});
if(!background)for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
for(let attempt=0;attempt<60&&!closed;attempt++){
  await new Promise(r=>setTimeout(r,300));const h=await health();if(h?.pid===child.pid){
    started=true;
    if(background){await writeFile(pidFile,JSON.stringify({pid:child.pid,port}),{mode:0o600});child.unref();console.log(`PaperMind已在后台启动：${url}\n停止：papermind --stop --port ${port}`);}openBrowser();break;
  }
  if(attempt===59){child.kill('SIGTERM');console.error('启动未完成，请查看数据目录中的server.log。');process.exitCode=1;}
}
