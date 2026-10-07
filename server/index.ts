import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import express from 'express';
import { createApp } from './app.ts';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=process.env.STUDY_DATA_DIR||join(homedir(),'.local','share','study-workbench');
const port=Number(process.env.PORT||4317);
const {app,store,knowledge}=await createApp(dataDir);
const server=createServer(app);
if(existsSync(join(root,'dist','index.html'))&&process.env.STUDY_DEV!=='1'){
  app.use(express.static(join(root,'dist')));app.get('/{*path}',(_req,res)=>res.sendFile(join(root,'dist','index.html')));
}else{
  const {createServer:createVite}=await import('vite');const vite=await createVite({root,server:{middlewareMode:true,hmr:{server}},appType:'spa'});app.use(vite.middlewares);
}
server.listen(port,'127.0.0.1',()=>{knowledge.start();console.log(`PaperMind已启动：http://127.0.0.1:${port}\n数据保存在本机：${dataDir}`);});
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{await knowledge.stop();server.close(()=>{store.close();process.exit(0);});});
