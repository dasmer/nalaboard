import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {config,db,query,rpc} from '../server/config.mjs';
import {hash,otpHash,secret} from '../server/auth.mjs';
const linked=JSON.parse(readFileSync(new URL('../.insforge/project.json',import.meta.url)));
assert.equal(config.environment,'test');assert.ok(['nalaboard-test','nalaboard-series-test'].includes(linked.project_name));assert.equal(config.url,linked.oss_host);
const origin=process.env.TEST_ORIGIN || 'http://localhost:4192', prefix='status'+Date.now().toString(36), ids=[],emails=[];
let checks=0,dailyDay;
const check=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
async function call(path,method='GET',body,cookie='',token) {
 const r=await fetch(origin+'/api/v1'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,'Idempotency-Key':randomUUID(),...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,value:await r.json(),cookie:r.headers.getSetCookie()[0]?.split(';')[0]};
}
async function login(email,code='123450') {
 await rpc('nb_request_otp',{p_email:email,p_hash:otpHash(email,code),p_ip:prefix+email});
 const r=await call('/auth/verify','POST',{email,code});check(r.status,200,'Fixture login');
 const state=(await call('/state','GET',undefined,r.cookie)).value;
 return {id:state.user.id,email,cookie:r.cookie};
}
async function create(suffix,admin=false) {
 const email=prefix+suffix+'@nala.money';emails.push(email);const p=await login(email);ids.push(p.id);
 if(admin)await query(db.database.from('nb_player_admins').insert([{player_id:p.id}]));return p;
}
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
let a,b,t;
try {
 a=await create('admin',true);b=await create('second',true);t=await create('target');
 const status=(target,active,who=a)=>call('/players/'+target.id+'/status','PATCH',{active},who.cookie);
 const recorded=await call('/matches','POST',{opponent:t.id,games:[{score1:11,score2:7}],date:today},a.cookie);
 check(recorded.status,200);
 await query(db.database.from('nb_players').update({weekly_recap:false}).eq('id',t.id));
 const key=(await call('/agent-keys','POST',{label:'Fixture'},t.cookie)).value.token;
 check(typeof key,'string');
 const adminAgent=(await call('/agent-keys','POST',{label:'Admin fixture'},a.cookie)).value.token;
 check((await call('/players/'+t.id+'/status','PATCH',{active:false},'',adminAgent)).status,401,'Agent sessions cannot administer accounts');
 check((await status(a,false,t)).status,403,'Ordinary player cannot change status');
 check((await status(a,false)).status,403,'Admin cannot deactivate self');
 check((await call('/state','GET',undefined,a.cookie)).value.playerAdmin,true);
 check((await call('/state','GET',undefined,t.cookie)).value.playerAdmin,false);
 await query(db.database.from('nb_display_admins').insert([{player_id:b.id}]));
 const paired=await call('/display/pair','POST',{});
 check((await call('/display/approve','POST',{code:paired.value.code},b.cookie)).status,200);
 check((await call('/players/'+t.id+'/status','PATCH',{active:false},paired.cookie)).status,401,'Display credentials cannot administer players');
 const results=await Promise.all([status(t,false),status(t,false)]);check(results.map(r=>r.status),[200,200],'Repeated status change is idempotent');
 const audit=await query(db.database.from('nb_activity').select('actor,after_data').eq('action','player.deactivated').eq('after_data->>playerId',t.id));
 check(audit.length,1);check(audit[0].actor,a.id,'Audit names the administering human');
 check((await call('/state','GET',undefined,t.cookie)).value.user,null,'Browser session revoked');
 check((await call('/me','PATCH',{bio:'Blocked'},t.cookie)).status,401);
 check((await call('/agent-keys','POST',{label:'Blocked'},t.cookie)).status,401);
 check((await call('/matches','POST',{opponent:a.id,games:[{score1:11,score2:1}],date:today},'',key)).status,401,'Agent key revoked');
 check((await call('/auth/request','POST',{email:t.email})).status,403,'Inactive sign-in never sends an OTP');
 check((await call('/auth/verify','POST',{email:t.email,code:'123450'})).status,403,'Previously issued OTP cannot admit inactive account');
 const before=await query(db.database.from('nb_players').select('active,notifications,weekly_recap,daily_matchups').eq('id',t.id));
 check(before[0],{active:false,notifications:true,weekly_recap:false,daily_matchups:true},'Preferences preserved while inactive');
 const queued=await query(db.database.from('nb_outbox').select('sent_at,last_error').eq('recipient',t.id));
 check(queued.length>0,true);check(queued.every(e=>e.sent_at && e.last_error==='Account inactive'),true,'Pending emails canceled');
 const blocked=await query(db.database.from('nb_outbox').insert([{event_id:randomUUID(),recipient:t.id,subject:'Fixture',payload:{action:'weekly.recap'}}]).select('id'));
 check(blocked.length,0,'All email producers skip inactive recipients');
 const publicState=(await call('/state?match='+recorded.value.id)).value;
 check(publicState.players.find(p=>p.id===t.id).active,false,'Public history keeps identity with inactive flag');
 check(publicState.matches.some(m=>m.id===recorded.value.id),true);
 check(publicState.standings.all.some(p=>p.id===t.id),true,'All-time result retained');
 check(publicState.standings.week.some(p=>p.id===t.id),false,'Current standings exclude inactive player');
 const match={opponent:t.id,games:[{score1:11,score2:7}],date:today};
 check((await call('/matches','POST',match,a.cookie)).status,400,'Personal entry rejects inactive opponent');
 check((await call('/display/matches','POST',{...match,player1:a.id},paired.cookie)).status,400,'Display rejects inactive opponent');
 check((await call('/display/matches','POST',{player1:t.id,opponent:a.id,games:match.games},paired.cookie)).status,400,'Display rejects inactive recorder');
 const correction=await call('/matches/'+recorded.value.id,'PATCH',{revision:1,games:[{score1:11,score2:8}]},a.cookie);
 check(correction.status,200,'Historical corrections by active participant remain available');
 const stats=(await call('/display/state','GET',undefined,paired.cookie)).value.snapshot;
 check(stats.players.find(p=>p.id===t.id).active,false,'Display retains historical names and flags inactive players');
 check(stats.standings.some(p=>p.id===t.id),false,'Big-screen standings exclude inactive player');
 // Pick a unique future weekday in this isolated project, then clean its snapshot.
 let day=new Date('2090-01-02T08:01:00Z');while(day.getUTCDay()!==1)day.setUTCDate(day.getUTCDate()+1);
 while((await query(db.database.from('nb_daily_runs').select('day').eq('day',day.toISOString().slice(0,10)))).length)day.setUTCDate(day.getUTCDate()+7);
 dailyDay=day.toISOString().slice(0,10);
 const snapshot=await rpc('nb_daily_snapshot',{p_now:day.toISOString()});check(snapshot.players.some(p=>p.id===t.id),false,'Daily pairing pool excludes inactive players');
 await query(db.database.from('nb_daily_runs').update({snapshot:{...snapshot,players:[...snapshot.players,{id:t.id,name:'Fixture target'}]}}).eq('day',dailyDay));
 const cached=await rpc('nb_daily_snapshot',{p_now:day.toISOString()});check(cached.players.some(p=>p.id===t.id),false,'A pending older snapshot also excludes newly inactive players');
 check((await status(t,true)).status,200);
 const restored=(await query(db.database.from('nb_players').select('active,notifications,weekly_recap,daily_matchups').eq('id',t.id)))[0];
 check(restored,{active:true,notifications:true,weekly_recap:false,daily_matchups:true});
 check((await call('/state','GET',undefined,t.cookie)).value.user,null,'Reactivation does not revive browser session');
 check((await call('/me','PATCH',{bio:'Blocked'},'',key)).status,401,'Reactivation does not revive agent key');
 check((await call('/auth/verify','POST',{email:t.email,code:'123450'})).status,401,'Pre-deactivation OTP stays invalid');
 const stillCanceled=await query(db.database.from('nb_outbox').select('sent_at').eq('recipient',t.id));check(stillCanceled.every(e=>e.sent_at),true,'No missed emails re-queued');
 const fresh=await login(t.email,'123451');
 check((await call('/matches','POST',{opponent:a.id,games:[{score1:11,score2:2}],date:today},fresh.cookie)).status,200,'Fresh sign-in restores participation');
 check((await status(b,false)).status,200);
 check((await call('/display/state','GET',undefined,paired.cookie)).value.active,true,'Office display survives activating admin deactivation');
 check((await call('/display/approve','POST',{code:paired.value.code},b.cookie)).status,401,'Inactive display admin cannot approve');
 const after=await call('/display/matches','POST',{player1:a.id,opponent:t.id,games:[{score1:11,score2:4}]},paired.cookie);check(after.status,200,'Shared display still records for active players');
 check((await status(b,true)).status,200);
 b=await login(b.email,'123451');
 const adminRace=await Promise.all([status(b,false,a),status(a,false,b)]);
 check(adminRace.map(r=>r.status).sort(),[200,401],'Concurrent admins cannot deactivate each other and remove the final active admin');
 const survivor=adminRace[0].status===200?a:b;
 await query(db.database.from('nb_otp').delete().eq('email',t.email));
 await rpc('nb_request_otp',{p_email:t.email,p_hash:otpHash(t.email,'123452'),p_ip:prefix+'race'});
 const [admission,deactivated]=await Promise.all([call('/auth/verify','POST',{email:t.email,code:'123452'}),status(t,false,survivor)]);
 check(deactivated.status,200);
 check([200,403].includes(admission.status),true,'Concurrent OTP verification is either completed first or rejected');
 if(admission.cookie)check((await call('/state','GET',undefined,admission.cookie)).value.user,null,'A concurrently issued session is also revoked');
 console.log(`Passed ${checks} player-status API/database checks on ${linked.project_name}. No production changes or email sends.`);
} finally {
 if(ids.length){
  const matches=await query(db.database.from('nb_matches').select('id').in('player1',ids).limit(100));const mids=matches.map(m=>m.id);
  if(mids.length){for(const table of ['nb_comments','nb_reactions','nb_subscriptions','nb_activity'])await query(db.database.from(table).delete().in('match_id',mids));await query(db.database.from('nb_matches').delete().in('id',mids));}
  for(const table of ['nb_outbox','nb_activity','nb_requests','nb_sessions','nb_displays','nb_display_admins','nb_player_admins']){
   const field=table==='nb_outbox'?'recipient':table==='nb_activity'?'actor':table==='nb_displays'?'activated_by':'player_id';await query(db.database.from(table).delete().in(field,ids));
  }
  await query(db.database.from('nb_otp').delete().in('email',emails));
  await query(db.database.from('nb_players').delete().in('id',ids));
 }
 if(dailyDay)await query(db.database.from('nb_daily_runs').delete().eq('day',dailyDay));
}
