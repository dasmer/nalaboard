import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import sharp from 'sharp';
import {matchShareURL,publicReceipt,serveMatchShare,matchCard} from '../match-share.mjs';
const key='fixture-sharing-secret',matchResult={id:'test-match',player1:'a',player2:'b',score1:2,score2:1,date:'2026-10-08',revision:1,
  games:[{score1:11,score2:7},{score1:9,score2:11},{type:'deuce',winner:1}],notes:'PRIVATE NOTES',history:['PRIVATE HISTORY'],comments:['PRIVATE COMMENT']};
const players=[{id:'a',name:'Alex <script>alert(1)</script>',email:'PRIVATE EMAIL',image:'PRIVATE PHOTO'},{id:'b',name:'Jordan'}];
const receipt=publicReceipt(matchResult,players);
assert.deepEqual(Object.keys(receipt).sort(),['date','games','names','revision','score1','score2']);
let loads=0;let origin;
const server=http.createServer(async(req,res)=>{try{if(!await serveMatchShare(req,res,{origin,key,load:async id=>{loads++;return id===matchResult.id?{matchResult,players}:null;}})){res.statusCode=404;res.end();}}catch(e){res.statusCode=500;res.end(e.message);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
try {
  const url=matchShareURL({origin,id:matchResult.id,key});
  assert.equal(url,`${origin}/g/${matchResult.id}/${createHmac('sha256',key).update(`nalaboard:game-share:v1:real:${matchResult.id}`).digest('hex')}`,'Previously shared real links retain their signatures');
  for(const invalid of [url.slice(0,-1)+(url.endsWith('0')?'1':'0'),url.replace(matchResult.id,'another-match'),url.replace('/g/','/demo/g/'),origin+'/g/test-match/invalid']) {
    assert.equal((await fetch(invalid)).status,404);
  }
  assert.equal(loads,0,'Invalid signatures must not query private match data');
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
  matchResult.revision=2;assert.ok((await (await fetch(url)).text()).includes('/image.png?v=2'));
  assert.ok(html.includes('Best of three'));
  matchResult.games=[{score1:11,score2:7}];matchResult.score1=1;matchResult.score2=0;matchResult.revision=3;
  const singleHTML=await (await fetch(url)).text();
  assert.ok(singleHTML.includes('Single-game match'));
  assert.ok(!singleHTML.includes('Best of three'));
  assert.ok(singleHTML.includes('1 : 0'));
  assert.ok(singleHTML.includes('/image.png?v=3'));
  // The format must also change in the rendered image, not only its HTML metadata.
  const singleCard=await matchCard(publicReceipt(matchResult,players));
  matchResult.games.push({score1:11,score2:9});
  assert.notDeepEqual(singleCard,await matchCard(publicReceipt(matchResult,players)));
  const missing=matchShareURL({origin,id:'missing-match',key});assert.equal((await fetch(missing)).status,404);
  assert.throws(()=>matchShareURL({origin,id:matchResult.id}),/signing secret/);
} finally {await new Promise(resolve=>server.close(resolve));}
console.log('Match share checks passed: capability isolation, escaped public allowlist, bot metadata, PNG size, corrections, HEAD, and missing games.');
