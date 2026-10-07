import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('V2-F01：被无关服务占用端口时，后台启动明确失败并保留诊断日志',async()=>{
  const occupied=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:'unrelated-local-test'}));});
  await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve));
  const port=(occupied.address() as {port:number}).port;
  const dir=await mkdtemp(join(tmpdir(),'yejian-cli-conflict-'));
  try{
    const result=await new Promise<{error:Error|null;stdout:string;stderr:string}>(resolve=>execFile(process.execPath,[fileURLToPath(new URL('../bin/yejian.mjs',import.meta.url)),'--background','--no-open','--port',String(port)],{env:{...process.env,STUDY_DATA_DIR:dir},timeout:15000},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
    assert.ok(result.error,'启动失败必须返回非零状态');
    assert.match(result.stderr,/启动失败/);
    assert.match(result.stderr,/server\.log/);
    assert.doesNotMatch(result.stdout,/已在后台启动/);
    assert.match(await readFile(join(dir,'server.log'),'utf8'),/EADDRINUSE/);
    await assert.rejects(readFile(join(dir,`service-${port}.json`)));
    assert.deepEqual(await(await fetch(`http://127.0.0.1:${port}/api/health`)).json(),{app:'unrelated-local-test'});
  }finally{await new Promise<void>(resolve=>occupied.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test('PaperMind 主命令与旧入口保持兼容',async()=>{
 for(const file of ['papermind.mjs','yejian.mjs']){
  const output=await new Promise<string>((resolve,reject)=>execFile(process.execPath,[fileURLToPath(new URL(`../bin/${file}`,import.meta.url)),'--help'],(error,stdout)=>error?reject(error):resolve(stdout)));
  assert.match(output,/PaperMind/);assert.match(output,/papermind notes/);
 }
});
