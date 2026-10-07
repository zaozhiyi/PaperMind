import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error launcher module is intentionally plain JS
import { serviceNetworkEnv } from '../bin/network.mjs';
const proxy='HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 12345\nHTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 12345';
test('启动器继承已启用的系统代理，本机服务直连；显式环境设置优先',()=>{
 const detected=serviceNetworkEnv({},'darwin',()=>proxy);
 assert.equal(detected.HTTPS_PROXY,'http://localhost:12345');assert.equal(detected.NODE_USE_ENV_PROXY,'1');assert.match(detected.NO_PROXY,/127\.0\.0\.1/);
 const explicit=serviceNetworkEnv({https_proxy:'http://custom:8080',no_proxy:'.example.com'},'darwin',()=>{throw new Error('must not inspect');});
 assert.equal(explicit.https_proxy,'http://custom:8080');assert.equal(explicit.HTTPS_PROXY,undefined);assert.match(explicit.NO_PROXY,/\.example\.com/);
 assert.deepEqual(serviceNetworkEnv({},'linux',()=>proxy),{});
 assert.deepEqual(serviceNetworkEnv({},'darwin',()=>{throw new Error('unavailable');}),{});
 assert.deepEqual(serviceNetworkEnv({},'darwin',()=>proxy.replaceAll('Enable : 1','Enable : 0')),{});
});
