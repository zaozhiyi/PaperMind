import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {GithubClient} from '../../server/integrations.ts';
const sha=(text:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
export class FakeGithub implements GithubClient {
 head='head-1';treeSha='tree-1';files=new Map<string,string>();blobs=new Map<string,string>();calls:{method:string;path:string;body:any}[]=[];
 pendingTree:{path:string;sha:string}[]=[];advanceDuringPush=false;
 async request<T=any>(method:string,path:string,body?:any):Promise<T>{
  this.calls.push({method,path,body});let result:any;
  if(path==='user')result={login:'fixture-user'};
  else if(method==='GET'&&path==='repos/owner/repo')result={default_branch:'main',private:true,permissions:{push:true}};
  else if(method==='GET'&&path.includes('/git/ref/'))result={object:{sha:this.head}};
  else if(method==='GET'&&path.includes('/git/commits/'))result={tree:{sha:this.treeSha}};
  else if(method==='GET'&&path.includes('/git/trees/'))result={truncated:false,tree:[...this.files].map(([path,content])=>({path,sha:sha(content),type:'blob',mode:'100644'}))};
  else if(method==='GET'&&path.includes('/git/blobs/')){const content=this.blobs.get(path.split('/').at(-1)!)!;result={encoding:'base64',content:Buffer.from(content).toString('base64'),size:Buffer.byteLength(content)};}
  else if(method==='POST'&&path.endsWith('/git/blobs')){const id=sha(body.content);this.blobs.set(id,body.content);result={sha:id};}
  else if(method==='POST'&&path.endsWith('/git/trees')){this.pendingTree=body.tree;result={sha:'tree-new'};}
  else if(method==='POST'&&path.endsWith('/git/commits')){assert.deepEqual(body.parents,[this.head]);result={sha:'commit-new'};if(this.advanceDuringPush)this.head='concurrent-commit';}
  else if(method==='PATCH'&&path.includes('/git/refs/')){assert.equal(body.force,false);if(this.head==='concurrent-commit')throw new Error('non-fast-forward');for(const file of this.pendingTree)this.files.set(file.path,this.blobs.get(file.sha)!);this.head=body.sha;result={object:{sha:body.sha}};}
  else throw new Error(`Unexpected fake request: ${method} ${path}`);
  return result as T;
 }
}
