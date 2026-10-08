import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
export async function notesCommand(args,url){
 const action=args[1],value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
 const request=async(path,body)=>{let headers={};if(body){const session=await(await fetch(url+'/api/session')).json();headers={'content-type':'application/json','x-study-token':session.token};}const r=await fetch(url+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.message||`HTTP ${r.status}`);return data;};
 if(action==='list')return console.log(JSON.stringify(await request('/api/notes'),null,2));
 if(action==='get'){if(!args[2]||args[2].startsWith('--'))throw new Error('请提供文档 ID。');const note=await request('/api/notes/'+encodeURIComponent(args[2]));console.log(JSON.stringify(note,null,2));return;}
 if(action==='import'){
  const file=args[2];if(!file||file.startsWith('--'))throw new Error('用法：papermind notes import file.md [--id UUID --revision N] [--title 标题] [--key 标识]');
  const body=file==='-'?await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>{text+=s;if(text.length>500000)reject(new Error('文件超过大小限制。'));});process.stdin.on('end',()=>resolve(text));process.stdin.on('error',reject);}):await readFile(resolve(file),'utf8');
  const format=value('--format')||(extname(file).toLowerCase()==='.html'?'html':'markdown');
  if(!['markdown','html'].includes(format))throw new Error('仅支持 markdown 或 html。');
  const revision=value('--revision');if(revision&&(!Number.isInteger(Number(revision))||Number(revision)<1))throw new Error('revision 必须为正整数。');
  const result=await request('/api/agent/documents',{body,format,title:value('--title'),id:value('--id'),revision:revision?Number(revision):undefined,key:value('--key')||(file==='-'?undefined:resolve(file))});
  console.log(JSON.stringify({id:result.note.id,title:result.note.title,revision:result.note.revision,created:result.created,warnings:result.warnings,diagrams:result.diagrams,url:url+result.url},null,2));return;
 }
 throw new Error('用法：papermind notes list | get ID | import file.md [--id ID --revision N]');
}
