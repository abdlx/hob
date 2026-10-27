import assert from 'node:assert/strict';
import net from 'node:net';
import {createHermesRoutes} from '../hermes-routes.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HermesBotIsolation, isolationRequest, isolationMode, prepareBotIsolation } from '../hermes-isolation.mjs';

const owner = { version: 1, profile: 'worker', uid: 20001, gid: 20001, user: 'hob20001', host: '127.0.0.1', port: 22220, workspace: '/opt/data/workspaces/bots/worker', keyPath: '/opt/data/.hob/isolation-keys/worker.key' };
test('OS setup preserves other native settings and rejects uncertain broker/config results', async () => {
 const calls=[]; let reply=owner, reject=false;
 const isolation=new HermesBotIsolation({ request:async(op,name)=>{ calls.push([op,name]); return reply; } });
 const current={model:'retained',terminal:{timeout:90,backend:'local'}};
 const client={dashboard:async(route,options)=>{ calls.push([route,options]); if(options.method==='PUT'){ if(reject)return {ok:false}; Object.assign(current.terminal,options.body.config.terminal); return {ok:true}; } return current; }};
 await isolation.configure(client,'worker'); assert.equal(current.model,'retained'); assert.equal(current.terminal.timeout,90); assert.equal(current.terminal.backend,'ssh'); assert.equal(isolation.status('worker').ready,true);
 calls.length=0; await isolation.configure(client,'worker'); assert.equal(calls.filter(c=>c[1]?.method==='PUT').length,0);
 reply={...owner,uid:0}; await assert.rejects(isolation.configure(client,'worker'),{code:'ISOLATION_UNAVAILABLE'});
 reply=owner; current.terminal.backend='local'; reject=true; await assert.rejects(isolation.configure(client,'worker'),{code:'ISOLATION_UNAVAILABLE'});
});
test('startup prepares enrolled principals before execution, including durable revocations', async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'hob-os-'));
 try {
  await writeFile(path.join(root,'bots.json'),JSON.stringify({bots:[{name:'default',state:'active'},{name:'worker',state:'setup_required',nativeCreated:true},{name:'unused',state:'setup_required'},{name:'old',state:'revoked'}]}));
  const calls=[]; const isolation={ready:async()=>calls.push('ready'),configure:async(_c,name)=>calls.push(name),revoke:async name=>calls.push('revoke:'+name)};
  await prepareBotIsolation(isolation,{dashboard:async()=>({profiles:[{name:'default'},{name:'worker'}]})},root); assert.deepEqual(calls,['ready','default','worker','revoke:old']);
  calls.length=0; await assert.rejects(prepareBotIsolation(isolation,{dashboard:async()=>({profiles:[{name:'unregistered'}]})},root),{code:'ISOLATION_UNENROLLED_PROFILE'}); assert.deepEqual(calls,[]);
  calls.length=0; isolation.ready=async()=>{throw Error('offline');}; await assert.rejects(prepareBotIsolation(isolation,{dashboard:async()=>({profiles:[{name:'default'}]})},root),/offline/); assert.deepEqual(calls,[]);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('private broker protocol bounds replies, refuses malformed/refused results, and never retries',async t=>{
 const socketPath=process.platform==='win32' ? '\\\\.\\pipe\\hob-os-test-'+process.pid : path.join(tmpdir(),'hob-os-'+process.pid+'.sock');
 let count=0, reply=''; const server=net.createServer(socket=>{ count++; socket.once('data',()=>socket.end(reply)); });
 await new Promise(resolve=>server.listen(socketPath,resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
 reply=JSON.stringify({ok:true,result:owner})+'\n'; assert.deepEqual(await isolationRequest('ensure','worker',{socketPath}),owner); assert.equal(count,1);
 for(const value of ['bad\n',JSON.stringify({ok:false,error:'private detail'})+'\n','x'.repeat(17000)]) {
  reply=value; await assert.rejects(isolationRequest('ensure','worker',{socketPath}),{code:'ISOLATION_UNAVAILABLE'});
 }
 assert.equal(count,4); await assert.rejects(isolationRequest('exec','worker',{socketPath})); assert.equal(count,4);
});
test('isolation mode rejects unknown backends and unsupported hosts explicitly',()=>{
 assert.equal(isolationMode({}),'shared'); assert.throws(()=>isolationMode({HOB_ISOLATION:'typo'}));
 if(process.platform!=='linux')assert.throws(()=>isolationMode({HOB_ISOLATION:'users'}),/Linux/);
});

test('dashboard cannot replace an isolated execution backend or inject a terminal override',async()=>{
 const calls=[]; const client={dashboard:async(...args)=>{calls.push(args);return {ok:true};}};
 const route=createHermesRoutes(client,{isolationStatus:()=>({mode:'users'})});
 const dispatch=async(config)=>route({method:'PUT'},{},new URL('http://local/api/hermes/config'),{body:async()=>({config}),json:()=>{}});
 for(const key of ['backend','cwd','ssh_host','ssh_port','ssh_user','ssh_key']) await assert.rejects(dispatch({terminal:{[key]:'untrusted'}}),{code:'MANAGED_ISOLATION'});
 for(const key of ['backend','cdp_url']) await assert.rejects(dispatch({browser:{[key]:'untrusted'}}),{code:'MANAGED_ISOLATION'});
 assert.equal(calls.length,0); await dispatch({terminal:{timeout:90}}); assert.equal(calls.length,1);
});
