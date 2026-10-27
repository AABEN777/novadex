import { ethers } from 'ethers';
import ganache from 'ganache';
import fs from 'fs';
import handler from './settle-deadlines.js';

const build=JSON.parse(fs.readFileSync('build.json','utf8'));
const M=1_000_000n;
let pass=0,fail=0;
const ok=(n,c,x='')=>c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n+' '+x));

// minimal express-ish mock
function mockRes(){const r={_s:200,_j:null};r.status=c=>{r._s=c;return r};r.json=o=>{r._j=o;return r};return r}
const run=async(secret='s3cret')=>{const res=mockRes();await handler({headers:{authorization:'Bearer '+secret}},res);return res};

const PORT=8599;
const server=ganache.server({logging:{quiet:true},wallet:{totalAccounts:6,defaultBalance:1000},chain:{chainId:1337}});
await server.listen(PORT);
const gp=server.provider;
const RPC_URL='http://127.0.0.1:'+PORT;
const prov=new ethers.JsonRpcProvider(RPC_URL,null,{staticNetwork:ethers.Network.from(1337),batchMaxCount:1});
const accts=gp.getInitialAccounts();
const keys=Object.entries(accts).map(([a,v])=>({addr:a,key:v.secretKey}));
const [dep,sender,recip,keeper]=keys.slice(0,4).map(k=>new ethers.Wallet(k.key,prov));
const A=async s=>await s.getAddress();

const deploy=async(art,...a)=>{const f=new ethers.ContractFactory(art.abi,art.evm.bytecode.object,dep);const c=await f.deploy(...a);await c.waitForDeployment();return c};
const usdc=await deploy(build.usdc);
const esc=await deploy(build.escrow,await A(dep),[await usdc.getAddress()]);
const EC=await esc.getAddress();

const keeperKey=keys[3].key;

process.env.CRON_SECRET='s3cret';
process.env.ARC_RPC=RPC_URL;
process.env.ESCROW_CONTRACT=EC;
process.env.KEEPER_PRIVATE_KEY=keeperKey;
process.env.ARC_CHAIN_ID='1337';


await (await usdc.mint(await A(sender),1000n*M)).wait();
await (await usdc.connect(sender).approve(EC,1000n*M)).wait();
const mk=async(dur)=>{const t=await esc.connect(sender).createEscrow(await A(recip),await usdc.getAddress(),100n*M,dur,ethers.id('x'));
  const r=await t.wait();return r.logs.map(l=>{try{return esc.interface.parseLog(l)}catch{return null}}).find(x=>x&&x.name==='EscrowCreated').args.id};
const warp=async s=>{await prov.send('evm_increaseTime',[s]);await prov.send('evm_mine',[])};
const bal=async s=>await usdc.balanceOf(await A(s));

console.log('\n── auth ──');
{ const r=await run('wrong'); ok('rejects a bad cron secret',r._s===401); }

console.log('\n── nothing due ──');
{ await mk(3600); const r=await run(); ok('does nothing before the deadline',r._j.settled===0,JSON.stringify(r._j)); }

console.log('\n── settles a delivered escrow to the recipient ──');
{ const id=await mk(3600);
  await (await esc.connect(recip).markDelivered(id)).wait();
  await warp(4*24*3600);
  const before=await bal(recip);
  const r=await run();
  ok('keeper settled it',r._j.settled>=1,JSON.stringify(r._j));
  ok('recipient received the funds',(await bal(recip))-before===100n*M);
  ok('status is Released',Number((await esc.getEscrow(id)).status)===3);
}

console.log('\n── refunds an undelivered escrow to the sender ──');
{ const id=await mk(3600);
  await warp(4*24*3600);
  const before=await bal(sender);
  await run();
  ok('sender refunded',(await bal(sender))-before===100n*M);
  ok('status is Refunded',Number((await esc.getEscrow(id)).status)===4);
}

console.log('\n── never touches a disputed escrow ──');
{ const id=await mk(3600);
  await (await esc.connect(recip).markDelivered(id)).wait();
  await (await esc.connect(sender).dispute(id)).wait();
  await warp(30*24*3600);
  const br=await bal(recip),bs=await bal(sender);
  const r=await run();
  ok('keeper leaves disputes alone',(await bal(recip))===br&&(await bal(sender))===bs);
  ok('still Disputed',Number((await esc.getEscrow(id)).status)===5);
}

console.log('\n── idempotent ──');
{ const id=await mk(3600);
  await (await esc.connect(recip).markDelivered(id)).wait();
  await warp(4*24*3600);
  const before=await bal(recip);
  await run(); await run(); await run();
  ok('running repeatedly pays out only once',(await bal(recip))-before===100n*M);
}

console.log('\n── batching ──');
{ // top up balance and allowance for this batch
  await (await usdc.mint(await A(sender),5000n*M)).wait();
  await (await usdc.connect(sender).approve(EC,5000n*M)).wait();
  const ids=[];
  for(let i=0;i<7;i++) ids.push(await mk(3600));
  await warp(4*24*3600);
  const r1=await run();
  ok('caps work per run to avoid timeouts',r1._j.settled<=5,'settled '+r1._j.settled);
  await run(); await run();
  let remaining=0;
  for(const id of ids){ if(await esc.isSettleable(id)) remaining++; }
  ok('backlog drains over successive runs',remaining===0,'remaining '+remaining);
}

console.log('\n════════════════');
console.log(`  ${pass} passed, ${fail} failed`);
await server.close();
process.exit(fail?1:0);
