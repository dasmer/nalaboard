import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {config,db,query,rpc} from '../server/config.mjs';
import {hash} from '../server/auth.mjs';
import {weeklyToken,weeklyEmail} from '../server/weekly-recap.mjs';
const link=JSON.parse(readFileSync(new URL('../.insforge/project.json',import.meta.url)));
assert.equal(config.environment,'test');assert(['burntboard-test','burntboard-series-test'].includes(link.project_name));assert.equal(config.deliveryEnabled,false);
const origin=process.env.TEST_ORIGIN,prefix='weekly'+Date.now(),ids=[randomUUID(),randomUUID(),randomUUID()],gameId=randomUUID(),credential=randomUUID();
const weeks=['2026-10-25','2026-11-01','2026-11-08'];
async function cleanWeek(week){const runs=await query(db.database.from('bb_weekly_runs').select('event_id').eq('week_start',week));for(const run of runs)await query(db.database.from('bb_outbox').delete().eq('event_id',run.event_id));await query(db.database.from('bb_weekly_runs').delete().eq('week_start',week));}
async function call(token,method='GET',body){const response=await fetch(origin+'/api/v1/weekly-preference'+(method==='GET'?'?token='+encodeURIComponent(token):''),{method,headers:{Origin:origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
try {
 for(const w of weeks)await cleanWeek(w);
 const people=await query(db.database.from('bb_players').insert(ids.map((id,i)=>({id,email:prefix+i+'@useallowance.com',username:prefix+i,name:'Weekly '+i}))).select());assert(people.every(p=>p.weekly_recap));
 await query(db.database.from('bb_sessions').insert([{player_id:ids[0],token_hash:hash(credential),kind:'agent',label:'Weekly test',expires_at:'2030-01-01T00:00:00Z'}]));
 const token=weeklyToken(ids[0],config.otpSecret);
 assert.equal((await call(token)).data.enabled,true);assert.equal((await call(token)).data.enabled,true,'Opening the link cannot unsubscribe');
 assert.equal((await call(token.slice(0,-2)+'xx')).status,401);
 assert.equal((await call(token,'POST',{token,enabled:true})).status,403,'Preference capability cannot opt someone in');
 assert.equal((await call(token,'POST',{token,enabled:false})).data.enabled,false);assert.equal((await call(token)).data.enabled,false);
 const restored=await fetch(origin+'/api/v1/weekly-preference',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+credential},body:JSON.stringify({enabled:true,player:ids[1]})});assert.equal(restored.status,200);
 const own=await(await fetch(origin+'/api/v1/state',{headers:{Authorization:'Bearer '+credential}})).json();assert.equal(own.user.weeklyRecap,true,'Account checkbox receives stored preference');assert(!('weeklyRecap' in own.players[0]));assert.equal((await call(token)).data.enabled,true,'Authenticated updates affect credential owner');
 await query(db.database.from('bb_players').update({weekly_recap:false}).eq('id',ids[2]));
 await query(db.database.from('bb_games').insert([{id:gameId,player1:ids[0],player2:ids[1],date:'2026-10-30',matches:[{score1:11,score2:7},{type:'deuce',winner:1}],created_at:'2026-10-31T01:00:00Z'}]));
 assert.equal(await rpc('bb_queue_weekly_recap',{p_now:'2026-10-31T02:29:59Z'}),0,'PDT: not before 7:30 PM');
 const concurrent=await Promise.all(Array.from({length:3},()=>rpc('bb_queue_weekly_recap',{p_now:'2026-10-31T02:30:00Z'})));assert.equal(concurrent.filter(n=>n>0).length,1,'Concurrent schedulers queue once');
 let run=(await query(db.database.from('bb_weekly_runs').select('*').eq('week_start',weeks[0])))[0];assert.equal(Date.parse(run.cutoff),Date.parse('2026-10-31T02:30:00Z'));assert.equal(run.snapshot.games.length,1);assert.equal(run.snapshot.games[0].score1,2);
 const outbox=await query(db.database.from('bb_outbox').select('recipient').eq('event_id',run.event_id));assert(outbox.some(x=>x.recipient===ids[0]));assert(!outbox.some(x=>x.recipient===ids[2]));
 assert.equal(await rpc('bb_queue_weekly_recap',{p_now:'2026-10-31T10:00:00Z'}),0,'Restart does not requeue');
 await query(db.database.from('bb_games').update({matches:[{score1:7,score2:11},{score1:8,score2:11}]}).eq('id',gameId));
 assert.equal((await query(db.database.from('bb_weekly_runs').select('snapshot').eq('week_start',weeks[0])))[0].snapshot.games[0].score1,2,'Queued results are immutable');
 const email=weeklyEmail({snapshot:run.snapshot,recipientId:ids[0],origin,key:config.otpSecret});assert(email.subject.includes('takes the week'));assert(email.html.includes('weekly-emails/'));
 await query(db.database.from('bb_games').update({date:'2026-11-06',created_at:'2026-11-07T02:00:00Z'}).eq('id',gameId));
 await query(db.database.from('bb_activity').insert([
   {actor:ids[0],game_id:gameId,action:'game.recorded',description:'Weekly fixture original',created_at:'2026-11-07T02:00:00Z',after_data:{score1:2,score2:0,matches:[{score1:11,score2:7},{score1:11,score2:8}]}},
   {actor:ids[0],game_id:gameId,action:'game.corrected',description:'Weekly fixture late correction',created_at:'2026-11-07T04:00:00Z',after_data:{score1:0,score2:2,matches:[{score1:7,score2:11},{score1:8,score2:11}]}}
 ]));
 await query(db.database.from('bb_players').update({weekly_recap:true,created_at:'2026-11-07T04:00:00Z'}).eq('id',ids[2]));
 assert.equal(await rpc('bb_queue_weekly_recap',{p_now:'2026-11-07T03:29:59Z'}),0,'PST: not before 7:30 PM');
 assert((await rpc('bb_queue_weekly_recap',{p_now:'2026-11-07T03:30:00Z'}))>0);
 run=(await query(db.database.from('bb_weekly_runs').select('*').eq('week_start',weeks[1])))[0];assert.equal(Date.parse(run.cutoff),Date.parse('2026-11-07T03:30:00Z'));
 assert.equal(run.snapshot.games[0].score1,2,'Catch-up uses result history before cutoff, not a later correction');
 assert(!(await query(db.database.from('bb_outbox').select('recipient').eq('event_id',run.event_id))).some(x=>x.recipient===ids[2]),'New signup after cutoff waits for next week');
 assert.equal(await rpc('bb_queue_weekly_recap',{p_now:'2026-11-14T03:30:00Z'}),0,'No games means no emails');
 console.log('Weekly real-backend checks passed: default on, read-only link, explicit scoped unsubscribe, authenticated resubscribe, PDT/PST timing, concurrent/restart deduplication, frozen results, recipient preferences and empty weeks. No emails sent.');
} finally {
 for(const w of weeks)await cleanWeek(w);
 await query(db.database.from('bb_activity').delete().in('actor',ids));
 await query(db.database.from('bb_games').delete().eq('id',gameId));
 await query(db.database.from('bb_sessions').delete().in('player_id',ids));
 await query(db.database.from('bb_players').delete().in('id',ids));
}
