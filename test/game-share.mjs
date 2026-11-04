import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import sharp from 'sharp';
import {gameShareURL,publicReceipt,serveGameShare} from '../game-share.mjs';
const key='fixture-sharing-secret',game={id:'test-game',player1:'a',player2:'b',score1:2,score2:1,date:'2026-10-08',revision:1,
  matches:[{score1:11,score2:7},{score1:9,score2:11},{score1:14,score2:12}],notes:'PRIVATE NOTES',history:['PRIVATE HISTORY'],comments:['PRIVATE COMMENT']};
const players=[{id:'a',name:'Alex <script>alert(1)</script>',email:'PRIVATE EMAIL',image:'PRIVATE PHOTO'},{id:'b',name:'Jordan'}];
const receipt=publicReceipt(game,players);
assert.deepEqual(Object.keys(receipt).sort(),['date','matches','names','revision','score1','score2']);
let loads=0;let origin;
const server=http.createServer(async(req,res)=>{try{if(!await serveGameShare(req,res,{origin,key,load:async id=>{loads++;return id===game.id?{game,players}:null;}})){res.statusCode=404;res.end();}}catch(e){res.statusCode=500;res.end(e.message);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
try {
  const url=gameShareURL({origin,id:game.id,key});
  assert.equal(url,`${origin}/g/${game.id}/${createHmac('sha256',key).update(`burntboard:game-share:v1:real:${game.id}`).digest('hex')}`,'Previously shared real links retain their signatures');
  for(const invalid of [url.slice(0,-1)+(url.endsWith('0')?'1':'0'),url.replace(game.id,'another-game'),url.replace('/g/','/demo/g/'),origin+'/g/test-game/invalid']) {
    assert.equal((await fetch(invalid)).status,404);
  }
  assert.equal(loads,0,'Invalid signatures must not query private game data');
  assert.equal((await fetch(url,{method:'POST'})).status,404);
  const response=await fetch(url),html=await response.text();
  assert.equal(response.status,200);assert.equal(response.headers.get('x-robots-tag'),'noindex, nofollow');
  assert.ok(html.includes('property="og:image"')&&html.includes('summary_large_image'));
  assert.ok(html.includes(url+'/image.png?v=1'));
  for(const sensitive of ['PRIVATE NOTES','PRIVATE HISTORY','PRIVATE COMMENT','PRIVATE EMAIL','PRIVATE PHOTO','<script>'])assert.ok(!html.includes(sensitive));
  assert.ok(html.includes('&lt;script&gt;'));
  const pngResponse=await fetch(url+'/image.png?v=1');assert.equal(pngResponse.headers.get('content-type'),'image/png');
  const metadata=await sharp(Buffer.from(await pngResponse.arrayBuffer())).metadata();assert.equal(metadata.width,1200);assert.equal(metadata.height,630);
  assert.equal((await fetch(url,{method:'HEAD'})).status,200);
  game.revision=2;assert.ok((await (await fetch(url)).text()).includes('/image.png?v=2'));
  const missing=gameShareURL({origin,id:'missing-game',key});assert.equal((await fetch(missing)).status,404);
  assert.throws(()=>gameShareURL({origin,id:game.id}),/signing secret/);
} finally {await new Promise(resolve=>server.close(resolve));}
console.log('Game share checks passed: capability isolation, escaped public allowlist, bot metadata, PNG size, corrections, HEAD, and missing games.');
