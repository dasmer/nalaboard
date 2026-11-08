import {gameWinner} from '../series.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,createHmac} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import sharp from 'sharp';
import {config,db,query,rpc,readQuery} from '../server/config.mjs';
import {hash,secret} from '../server/auth.mjs';
import {sendEmail} from '../server/email.mjs';
const linked=JSON.parse(readFileSync(new URL('../.insforge/project.json',import.meta.url)));
assert.equal(config.environment,'test');
assert.ok(['nalaboard-test','nalaboard-series-test'].includes(linked.project_name),'Integration fixtures must never enter production.');
assert.equal(config.url,linked.oss_host);
const origin=process.env.TEST_ORIGIN || 'http://localhost:4176';
const prefix='bb'+Date.now().toString(36);
let checks=0;
function check(actual,expected,message){assert.deepEqual(actual,expected,message);checks++;}
async function call(path,method='GET',body,auth={},key=randomUUID()) {
  const res=await fetch(origin+'/api/v1'+path,{method,headers:{'Content-Type':'application/json',Origin:origin,
    'Idempotency-Key':key,...auth},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await res.json();return {status:res.status,value,cookie:res.headers.get('set-cookie')};
}
async function login(suffix,kind='web',domain='nala.money') {
  const email=`${prefix}${suffix}@${domain}`,code='123450';
  const p_hash=createHmac('sha256',config.otpSecret).update(email+':'+code).digest('hex');
  await rpc('nb_request_otp',{p_email:email,p_hash,p_ip:prefix+suffix});
  const result=await call('/auth/verify','POST',{email:domain==='rafiki.com'?'  '+email.toUpperCase()+'  ':email,code,kind});
  check(result.status,200);
  check((await call('/auth/verify','POST',{email,code,kind})).status,401,'OTP cannot be reused');
  const auth=kind==='web'?{Cookie:result.cookie.split(';')[0]}:{Authorization:'Bearer '+result.value.token};
  if(kind==='web') {check(result.cookie.includes('HttpOnly'),true);check(result.value.token,undefined);}
  const snapshot=await call('/state','GET',undefined,auth);
  check(snapshot.status,200,'Authenticated state must load');
  const user=snapshot.value.user;
  return {email,auth,user};
}
const a=await login('a'),b=await login('b','web','useallowance.com'),c=await login('c','web','rafiki.com'),d=await login('d');
const publicState=(await call('/state')).value;
check(publicState.players.some(p=>p.id===a.user.id),true,'Anonymous visitors can browse players');
check(publicState.players.some(p=>'email' in p || 'notifications' in p),false,'Public players omit account fields');
check(publicState.games,undefined,'State exposes matches, with no old games alias');
check(publicState.user,null);check(publicState.keys,[]);check(publicState.activity,[]);
check((await call('/auth/request','POST',{email:'outsider@example.com'})).status,400);
check((await call('/auth/request','POST',{email:'bob@am.useallowance.com'})).status,400,'Test sink does not expand signup allowlist');
for (const domain of ['nala.com','getburnt.ai','sub.nala.money','nala.money.evil.test','sub.rafiki.com','rafiki.com.evil.test','rafikicom']) {
  const email=prefix+'outsider@'+domain;
  check((await call('/auth/request','POST',{email})).status,400,'Server rejects '+domain);
  const requested=await query(db.database.rpc('nb_request_otp',{p_email:email,p_hash:'fixture',p_ip:prefix}));
  check(requested.status,400,'Database OTP rejects '+domain);
  const inserted=await db.database.from('nb_players').insert([{email,name:'Blocked',username:prefix+'blocked'}]);
  check(Boolean(inserted.error),true,'Player table rejects '+domain);
}
const body={opponent:b.user.id,games:[{score1:11,score2:7},{score1:11,score2:9}],date:'2026-10-08',notes:'Integration test'};
check((await call('/games','POST',body,a.auth)).status,404,'The old games endpoint is removed');
const win=body.games[0],loss={score1:9,score2:11},deuce={type:'deuce',winner:1};
for(const games of [undefined,[],[win,loss],[win,win,loss],[loss,loss,win],
  [win,{score1:11,score2:10}],[win,{score1:13,score2:10}],[win,null]]) {
  check((await call('/matches','POST',{...body,games},a.auth)).status,400,'Reject invalid or unfinished series');
  if(games!==undefined) {
    const direct=await db.database.from('nb_matches').insert([{player1:a.user.id,player2:b.user.id,games,date:body.date}]);
    check(Boolean(direct.error),true,'Database independently rejects invalid series');
  }
}
for(const games of [[win],[loss],[deuce],[{type:'unrecorded',winner:2}],[win,win],[loss,loss],[win,loss,deuce],[loss,win,loss]]) {
  check(await rpc('nb_game_wins',{games,side:1}),games.filter(m=>gameWinner(m)===1).length,'SQL series validator agrees with game winners');
}
const key=randomUUID();
const recorded=await call('/matches','POST',body,a.auth,key);check(recorded.status,200);
const id=recorded.value.id;
const publicMatch=(await call('/state?match='+id)).value.matches.find(g=>g.id===id);
check(publicMatch.matches,undefined,'A match contains games, with no old matches alias');
check(publicMatch.games,body.games,'Anonymous visitors can read a match directly');
check('muted' in publicMatch,false,'Anonymous games exclude notification preferences');
for(const [path,method] of [['/matches','POST'],['/matches/'+id,'PATCH'],['/matches/'+id+'/react','POST'],['/matches/'+id+'/comments','POST'],['/matches/'+id+'/subscription','PATCH'],['/me','PATCH'],['/keys','POST'],['/auth/logout','POST']]) {
  check((await call(path,method,{})).status,401,'Public read access does not authorize writes');
}
check((await call('/matches/'+id+'/share')).status,401,'Sharing requires a signed-in participant');
check((await call('/matches/'+id+'/share','GET',undefined,c.auth)).status,403,'Nonparticipants cannot publish a receipt');
const shared=await call('/matches/'+id+'/share','GET',undefined,a.auth);check(shared.status,200);
check((await call('/matches/'+id+'/share','GET',undefined,b.auth)).value.url,shared.value.url,'Both participants share the same receipt');
const receiptResponse=await fetch(shared.value.url),receiptHTML=await receiptResponse.text();
check(receiptResponse.status,200,'Shared receipt is readable by an anonymous crawler');
check(receiptHTML.includes('property="og:image"'),true,'Preview metadata is present without client JavaScript');
check(receiptHTML.includes('Integration test'),false,'Private notes never enter public metadata or HTML');
check(receiptHTML.includes(a.email),false,'Emails stay private');
const sharedPNG=await fetch(shared.value.url+'/image.png?v=1');check(sharedPNG.status,200);
const sharedImage=await sharp(Buffer.from(await sharedPNG.arrayBuffer())).metadata();check([sharedImage.width,sharedImage.height],[1200,630]);
check((await fetch(shared.value.url.slice(0,-1)+(shared.value.url.endsWith('0')?'1':'0'))).status,404,'Tampered links cannot read games');
check((await call('/matches','POST',body,a.auth,key)).value.id,id,'Retry does not create a second match');
check((await call('/matches','POST',{...body,notes:'Changed'},a.auth,key)).status,409);
check((await call('/matches','POST',{...body,opponent:a.user.id},a.auth)).status,400);
check((await call('/matches','POST',{...body,games:[{score1:12,score2:7},{score1:11,score2:9}]},a.auth)).status,400);
check((await call('/matches','POST',{...body,date:'2099-01-01'},a.auth)).status,400);
check((await call('/matches/'+id,'PATCH',{games:[{score1:11,score2:9},{score1:11,score2:8}],revision:1},c.auth)).status,403);
const corrections=await Promise.all([call('/matches/'+id,'PATCH',{games:[{score1:11,score2:9},{score1:11,score2:8}],revision:1},a.auth),call('/matches/'+id,'PATCH',{games:[{score1:11,score2:8},{score1:11,score2:7}],revision:1},b.auth)]);
check(corrections.map(c=>c.status).sort(),[200,409],'Concurrent corrections must conflict');
let matchResult=(await call('/state','GET',undefined,a.auth)).value.matches.find(g=>g.id===id);
check(matchResult.revision,2);check(matchResult.history.length,2);check(matchResult.history[0].before.games[0].score2,7);
check(matchResult.notes,'Integration test','Score-only corrections preserve match notes');
check([matchResult.score1,matchResult.score2],[2,0],'Scores count game wins');
check((await call('/matches/'+id,'PATCH',{games:[win,loss,deuce],revision:2},b.auth)).status,200,'Player 2 can correct a deciding match using fixed player order');
let seriesState=(await call('/state','GET',undefined,a.auth)).value;
matchResult=seriesState.matches.find(g=>g.id===id);
check([matchResult.score1,matchResult.score2],[2,1]);check(matchResult.games,[win,loss,deuce]);
const correctedReceipt=await (await fetch(shared.value.url)).text();
check(correctedReceipt.includes('/image.png?v=3'),true,'Corrections version the OG image');
check(correctedReceipt.includes('won in deuce'),true,'The shared receipt reflects the corrected deciding match');
check(seriesState.standings.all.find(p=>p.id===a.user.id).wins,1,'A three-game match counts as one win');
check('points' in seriesState.standings.all.find(p=>p.id===a.user.id),false,'Incomplete point totals are not ranked');
const scoreEmail=(await query(db.database.from('nb_outbox').select('payload').eq('payload->>matchId',id).eq('payload->>action','match.corrected').order('created_at',{ascending:false}).limit(1)))[0];
check(scoreEmail.payload.after.games,[win,loss,deuce],'Notification preserves all match scores');
// A single match is a completed result, with the same participant/history safeguards.
const singleKey=randomUUID();
const single=await call('/matches','POST',{...body,games:[loss]},a.auth,singleKey);
check(single.status,200,'Single games can be recorded');
check((await call('/matches','POST',{...body,games:[loss]},a.auth,singleKey)).value.id,single.value.id,'Single-game retries are idempotent');
let singleState=(await call('/state?match='+single.value.id,'GET',undefined,a.auth)).value;
let singleMatch=singleState.matches.find(g=>g.id===single.value.id);
check([singleMatch.score1,singleMatch.score2],[0,1]);check(singleMatch.games,[loss]);
check(singleState.standings.all.find(p=>p.id===b.user.id).wins,1,'A single-game match counts as one win');
check(singleState.standings.all.find(p=>p.id===a.user.id).losses,1,'A single-game match counts as one loss');
check((await call('/matches/'+single.value.id,'PATCH',{games:[win],revision:1},c.auth)).status,403,'Single-game corrections require participation');
check((await call('/matches/'+single.value.id,'PATCH',{games:[win,win],revision:1},b.auth)).status,200,'Player 2 can change a single game to best of three');
check((await call('/matches/'+single.value.id,'PATCH',{games:[deuce],revision:2},b.auth)).status,200,'Player 2 can change best of three to a single deuce game');
singleMatch=(await call('/state?match='+single.value.id)).value.matches.find(g=>g.id===single.value.id);
check([singleMatch.score1,singleMatch.score2],[1,0]);check(singleMatch.revision,3);
check(singleMatch.history.length,3,'Format corrections retain all revisions');
check(singleMatch.history[0].before.games,[win,win],'History preserves the previous format');
check((await call('/matches/'+single.value.id,'PATCH',{games:[loss],revision:2},a.auth)).status,409,'Single-game corrections enforce revisions');
const singleShared=(await call('/matches/'+single.value.id+'/share','GET',undefined,b.auth)).value.url;
const singleReceipt=await (await fetch(singleShared)).text();
check(singleReceipt.includes('Single-game match'),true,'Shared receipts show the single-game format');
check(singleReceipt.includes('Best of three'),false);
const singleNotification=(await query(db.database.from('nb_outbox').select('payload').eq('payload->>matchId',single.value.id).eq('payload->>action','match.corrected').order('created_at',{ascending:false}).limit(1)))[0];
check(singleNotification.payload.after.games,[deuce],'Notifications preserve the single-game result');
await call('/me','PATCH',{username:prefix+'c',name:'Mention test C'},c.auth);
const comment=await call('/matches/'+id+'/comments','POST',{text:`Hello @${prefix}c`,mentions:[c.user.id]},a.auth);check(comment.status,200);
let mail=await query(db.database.from('nb_outbox').select('recipient,payload').eq('payload->>matchId',id).limit(20));
check(mail.filter(m=>m.payload.action==='comment.added').map(m=>m.recipient).sort(),[b.user.id,c.user.id].sort(),'Mention subscribes recipient on this comment, author excluded');
await call('/matches/'+id+'/comments','POST',{text:'Joining the conversation'},d.auth);
await call('/matches/'+id+'/comments','POST',{text:`Again @${prefix}c`,mentions:[c.user.id]},b.auth);
mail=await query(db.database.from('nb_outbox').select('recipient,payload,event_id').eq('payload->>matchId',id).order('created_at').limit(30));
const groups=Map.groupBy(mail.filter(m=>m.payload.action==='comment.added'),m=>m.event_id);
const recipients=[...groups.values()].at(-1).map(m=>m.recipient).sort();
check(recipients,[a.user.id,c.user.id,d.user.id].sort(),'Players, prior commenter, and mentioned people subscribe once');
check((await call('/matches/'+id+'/comments','POST',{text:'No handle here',mentions:[c.user.id]},a.auth)).status,400);
await call('/matches/'+id+'/subscription','PATCH',{muted:true},c.auth);
await call('/me','PATCH',{notifications:false},d.auth);
await call('/matches/'+id+'/comments','POST',{text:'Muted recipients stay quiet'},b.auth);
mail=await query(db.database.from('nb_outbox').select('recipient,event_id').eq('payload->>matchId',id).order('created_at',{ascending:false}).limit(1));
check(mail[0].recipient,a.user.id);
check((await call('/matches/'+id+'/comments','DELETE',{id:comment.value.id},c.auth)).status,403);
check((await call('/matches/'+id+'/comments','DELETE',{id:comment.value.id},a.auth)).status,200);
await call('/matches/'+id+'/react','POST',{emoji:'🔥'},a.auth);
await call('/matches/'+id+'/react','POST',{emoji:'👏'},a.auth);
matchResult=(await call('/state','GET',undefined,a.auth)).value.matches.find(g=>g.id===id);
check(matchResult.reactions['🔥'],undefined);check(matchResult.reactions['👏'],[a.user.id]);
await call('/matches/'+id+'/react','POST',{emoji:'👏'},a.auth);
matchResult=(await call('/state','GET',undefined,a.auth)).value.matches.find(g=>g.id===id);
check(Object.values(matchResult.reactions).flat().includes(a.user.id),false);
const connection=await call('/agent-keys','POST',{label:'Integration agent'},a.auth);check(connection.status,200);
const agent={Authorization:'Bearer '+connection.value.token};
const unrecorded={type:'unrecorded',winner:2};
const mixed=await call('/matches','POST',{...body,games:[win,unrecorded,deuce]},agent);check(mixed.status,200,'Agent records mixed result types');
const mixedMatch=(await call('/state','GET',undefined,a.auth)).value.matches.find(g=>g.id===mixed.value.id);
check(mixedMatch.games,[win,unrecorded,deuce]);check([mixedMatch.score1,mixedMatch.score2],[2,1]);
check((await call('/matches/'+mixed.value.id,'PATCH',{games:[win,win],revision:1},c.auth)).status,403);
const mixedShare=await call('/matches/'+mixed.value.id+'/share','GET',undefined,agent);
const mixedHTML=await (await fetch(mixedShare.value.url)).text();check(mixedHTML.includes('Score not recorded'),true);check(mixedHTML.includes('won in deuce'),true);check(mixedHTML.includes('undefined'),false);
for(const invalid of [{type:'deuce',winner:3},{type:'unrecorded',winner:1,score1:11},{score1:13,score2:11}]) {
  check((await call('/matches','POST',{...body,games:[win,invalid]},agent)).status,400);
  check(await rpc('nb_game_wins',{games:[win,invalid],side:1}),null,'Database rejects invalid match types independently');
}
check(await rpc('nb_game_wins',{games:[win,unrecorded,deuce],side:1}),2);
check((await call('/matches/'+id+'/share','GET',undefined,agent)).value.url,shared.value.url,'Agents have the same participant sharing capability');
check((await call('/state','GET',undefined,agent)).value.user.id,a.user.id);
check((await call('/me','PATCH',{bio:'Updated via agent'},agent)).status,200);
check((await call('/matches/'+id,'PATCH',{games:[loss,loss],revision:3},agent)).status,200,'Agent can record the opposite-player sweep');
matchResult=(await call('/state','GET',undefined,a.auth)).value.matches.find(g=>g.id===id);
check([matchResult.score1,matchResult.score2],[0,2]);check(matchResult.games.length,2,'Correction removes the unused decider');
check((await call('/matches/'+id+'/comments','POST',{text:'Agent comment'},agent)).status,200);
const events=(await call('/state','GET',undefined,a.auth)).value.activity;
check(events.some(e=>e.action==='comment.added' && e.agent==='Integration agent' && e.actor===a.user.id),true);
check((await call('/agent-keys/'+connection.value.id,'DELETE',{},c.auth)).status,404);
check((await call('/agent-keys/'+connection.value.id,'DELETE',{},a.auth)).status,200);
check((await call('/matches/'+id+'/comments','POST',{text:'Revoked'},agent)).status,401);
const expired=secret();await query(db.database.from('nb_sessions').insert([{player_id:a.user.id,kind:'agent',label:'Expired',token_hash:hash(expired),expires_at:'2000-01-01T00:00:00Z'}]));
check((await call('/me','PATCH',{bio:'Expired'}, {Authorization:'Bearer '+expired})).status,401);
const csrf=await fetch(origin+'/api/v1/me',{method:'PATCH',headers:{Cookie:a.auth.Cookie,'Content-Type':'application/json',Origin:'https://evil.example'},body:'{"bio":"CSRF"}'});
check(csrf.status,403);
check((await fetch(origin+'/.env.local')).status,404);check((await fetch(origin+'/server/config.mjs')).status,404);
for(const path of ['/demo','/demo/','/demo/api/v1/state','/demo/api/v1/auth/verify','/demo/g/fixture','/demo-agent.md','/images/players/dasmer.jpg']) {
  check((await fetch(origin+path)).status,404,'Retired demo paths are unavailable');
}
check((await fetch(origin+'/demo/api/v1/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404,'Retired demo login cannot authenticate');
check((await call('/auth/verify','POST',{email:a.email,code:'123456'})).status,401,'Demo code is not accepted by real login');
const timestamp=new Date().toISOString();
await query(db.database.from('nb_matches').insert(Array.from({length:105},(_,i)=>({player1:a.user.id,player2:b.user.id,
  games:[{score1:11,score2:7},{score1:11,score2:9}],date:i<102?'2026-10-08':'2026-10-07',notes:'Pagination fixture '+prefix,created_at:timestamp}))));
const firstPage=await call('/state?player='+a.user.id,'GET',undefined,a.auth);check(firstPage.status,200);
const page1=firstPage.value;
check(page1.matches.length,100);
check(page1.matches[0].date,'2026-10-08','Recently recorded older games must not jump ahead');
const nextPage=await call('/state?player='+a.user.id+'&matchesBefore='+encodeURIComponent(page1.pagination.matches),'GET',undefined,a.auth);check(nextPage.status,200);
const page2=nextPage.value;
check(page2.matches.length,8,'Same-timestamp pagination must not lose games');
const publicPage=(await call('/state?player='+a.user.id)).value;
check(publicPage.matches.length,100,'Public profile pagination is bounded');
check((await call('/state?player='+a.user.id+'&matchesBefore='+encodeURIComponent(publicPage.pagination.matches))).value.matches.length,8,'Public pagination preserves all games');
check(new Set([...page1.matches,...page2.matches].map(g=>g.id)).size,108);
const allMatches=[...page1.matches,...page2.matches];
check(allMatches.filter(g=>g.date==='2026-10-08').slice(0,102).every(g=>g.notes.startsWith('Pagination fixture ')),true,'Same-day ties put newly recorded games first');
const feed=(await call('/state')).value.matches;
check(feed.map(g=>g.date),feed.map(g=>g.date).sort().reverse(),'The unfiltered public feed also follows played dates');
check(allMatches.map(g=>g.date),allMatches.map(g=>g.date).sort().reverse(),'Played dates descend across page boundaries');
check(allMatches.filter(g=>g.notes.startsWith('Pagination fixture ')).slice(-3).every(g=>g.date==='2026-10-07'),true,'Backdated entries remain last despite newer recording time');
check(page1.standings.all.find(p=>p.id===a.user.id).played,108,'Standings include games beyond the first page');
check(page1.rivalries.find(r=>r.id===a.user.id && r.opponent===b.user.id).played,108);
check((await call('/state?matchesBefore=invalid','GET',undefined,a.auth)).status,400);
const image='data:image/png;base64,'+(await sharp({create:{width:8,height:8,channels:3,background:'#00a2dc'}}).png().toBuffer()).toString('base64');
check((await call('/me','PATCH',{image},a.auth)).status,200,'Photo is decoded and stored in private InsForge storage');
const photo=await fetch(origin+'/api/v1/photos/'+a.user.id,{headers:a.auth});check(photo.status,200);check(photo.headers.get('content-type'),'image/webp');
check((await fetch(origin+'/api/v1/photos/'+a.user.id)).status,200,'Player avatars are public');
check((await call('/me','PATCH',{image:'data:image/png;base64,ZmFrZQ=='},a.auth)).status,400);
check((await call('/me','PATCH',{image:null},a.auth)).status,200);
check((await fetch(origin+'/api/v1/photos/'+a.user.id,{headers:a.auth})).status,404);
check((await call('/state','GET',undefined,{Authorization:'Bearer '+a.auth.Cookie.split('=')[1]})).value.user,null,'Browser credentials cannot be reused as agent keys');
const snapshot=(await call('/state','GET',undefined,a.auth)).value;
check(snapshot.players.some(p=>'email' in p),false,'Roster does not expose other users emails');
check(snapshot.keys.some(k=>'token_hash' in k),false);
const lockedEmail=prefix+'locked@useallowance.com';
const digest=createHmac('sha256',config.otpSecret).update(lockedEmail+':123450').digest('hex');
await rpc('nb_request_otp',{p_email:lockedEmail,p_hash:digest,p_ip:prefix+'locked'});
for(let i=0;i<3;i++) check((await call('/auth/verify','POST',{email:lockedEmail,code:'999999'})).status,401);
check((await call('/auth/verify','POST',{email:lockedEmail,code:'123450'})).status,401,'Three wrong codes invalidate the challenge');
await query(db.database.from('nb_otp').update({attempts:0,expires_at:'2000-01-01T00:00:00Z'}).eq('email',lockedEmail));
check((await call('/auth/verify','POST',{email:lockedEmail,code:'123450'})).status,401,'Expired code is rejected');
const cooldown=await query(db.database.rpc('nb_request_otp',{p_email:lockedEmail,p_hash:digest,p_ip:prefix+'locked'}));
check(cooldown.status,429,'OTP resend cooldown is enforced');
check((await call('/auth/logout','POST',{},a.auth)).status,200);
check((await call('/me','PATCH',{bio:'After logout'},a.auth)).status,401,'Logout revokes the credential');
const eventId=randomUUID();
await query(db.database.from('nb_outbox').insert([{event_id:eventId,recipient:a.user.id,subject:'Lease fixture',payload:{},created_at:'2000-01-01T00:00:00Z'}]));
const claims=await Promise.all([query(db.database.rpc('nb_claim_emails',{p_event:eventId})),query(db.database.rpc('nb_claim_emails',{p_event:eventId}))]);
check(claims.flat().length,1,'Concurrent workers lease each notification only once');
check(claims.flat()[0].first_attempt_at!==null,true,'Old queued email may make its first attempt');
await query(db.database.from('nb_outbox').update({leased_until:null,first_attempt_at:'2000-01-01T00:00:00Z'}).eq('event_id',eventId));
check((await query(db.database.rpc('nb_claim_emails',{p_event:eventId}))).length,0,'Unknown delivery beyond provider deduplication window is not retried');
const sink=config.testSink;config.testSink=undefined;
try {await assert.rejects(sendEmail({to:'blocked@example.com',subject:'Never send',text:'Never send',key:randomUUID()}),/recipient is not allowed/);checks++;}
finally {config.testSink=sink;}
const mismatch=spawnSync(process.execPath,['server.mjs'],{encoding:'utf8',timeout:15000,
  env:{...process.env,APP_ENV:'production',APP_ORIGIN:'https://nalaboard.com',EMAIL_TEST_SINK:'',EMAIL_TEST_RECIPIENTS:''}});
check(mismatch.status,1,'A production server must refuse the test backend');
check(mismatch.stderr.includes('Backend environment does not match APP_ENV'),true);
let readAttempts=0;
check(await readQuery(async()=> ++readAttempts<3 ? {error:{message:'socket hang up'}} : {data:'recovered'}),'recovered');
check(readAttempts,3,'Transient read retries are bounded');
readAttempts=0;
await assert.rejects(readQuery(async()=>{readAttempts++;return {error:{message:'Permission denied'}};}),/Permission denied/);
check(readAttempts,1,'Permission errors are never retried');
console.log(`Passed ${checks} real InsForge/API checks on ${linked.project_name}. Test data is isolated; production is untouched.`);
