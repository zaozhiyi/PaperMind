export async function syncCommand(args,url){
 const action=args[1];
 const request=async(path,body)=>{const headers={};if(body){headers['content-type']='application/json';headers['x-study-token']=(await(await fetch(url+'/api/session')).json()).token;}const response=await fetch(url+'/api/knowledge/'+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw new Error(result.message);return result;};
 let result;
 if(action==='status')result=await request('status');
 else if(action==='now')result=await request('sync',{});
 else if(action==='pause')result=await request('pause',{});
 else if(action==='setup'){
  const repo=args[2];if(!repo||repo.startsWith('--'))throw new Error('用法：papermind sync setup owner/repo [--exclude ID,ID]');
  const old=(await request('status')).config;const at=args.indexOf('--exclude');
  const excludedIds=at<0?(old?.excludedIds||[]):(args[at+1]||'').split(',').filter(Boolean);
  result=await request('configure',{repo,excludedIds,enabled:true});
 }else throw new Error('用法：papermind sync setup owner/repo | status | now | pause');
 console.log(JSON.stringify(result,null,2));
}
