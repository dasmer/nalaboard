import assert from 'node:assert/strict';
import {checkProxy,clientIp} from '../server/proxy.mjs';
const secret='a'.repeat(64);
const req={headers:{'x-origin-secret':secret,'x-forwarded-for':'203.0.113.1, 192.0.2.1'},socket:{remoteAddress:'127.0.0.1'}};
assert.doesNotThrow(()=>checkProxy(req,secret));
for(const value of [undefined,'','wrong',secret+'x']) {
  assert.throws(()=>checkProxy({...req,headers:{...req.headers,'x-origin-secret':value}},secret),e=>e.status===403);
}
assert.doesNotThrow(()=>checkProxy(req,undefined));
assert.equal(clientIp(req,true),'203.0.113.1');
assert.equal(clientIp(req,false),'127.0.0.1');
assert.equal(clientIp({...req,headers:{}},true),'127.0.0.1');
console.log('Proxy secret and visitor IP checks passed.');
