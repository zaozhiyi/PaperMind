import { execFileSync } from 'node:child_process';

// Follow the user's configured network route without changing system settings.
export function serviceNetworkEnv(env=process.env,platform=process.platform,readProxy=()=>execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:2000})) {
 const next={...env};
 if(platform==='darwin'&&!['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'].some(k=>next[k])) {
  try {
   const settings=readProxy();
   const get=key=>settings.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`,'m'))?.[1].trim();
   for(const protocol of ['HTTP','HTTPS'])if(get(`${protocol}Enable`)==='1') {
    const host=get(`${protocol}Proxy`),port=get(`${protocol}Port`);
    if(host&&/^[a-zA-Z0-9.-]+$/.test(host)&&port&&/^\d+$/.test(port)&&Number(port)>0&&Number(port)<=65535)next[`${protocol}_PROXY`]=`http://${host}:${port}`;
   }
  }catch{/* No configured system proxy: use the existing network environment. */}
 }
 if(next.HTTP_PROXY||next.HTTPS_PROXY||next.http_proxy||next.https_proxy){
  next.NODE_USE_ENV_PROXY??='1';
  next.NO_PROXY=[next.NO_PROXY||next.no_proxy,'localhost','127.0.0.1','::1'].filter(Boolean).join(',');
 }
 return next;
}
