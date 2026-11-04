import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {config,db,query,rpc} from '../server/config.mjs';
import {hash} from '../server/auth.mjs';
import {dailyPairs,dailyToken} from '../server/daily-matchups.mjs';
import {weeklyToken} from '../server/weekly-recap.mjs';
const link=JSON.parse(readFileSync(new URL('../.insforge/project.json',import.meta.url)));
assert.equal(config.environment,'test');assert(['burntboard-test','burntboard-series-test'].includes(link.project_name));assert.equal(config.deliveryEnabled,false);
const origin=process.env.TEST_ORIGIN,prefix='daily'+Date.now(),ids=Array.from({length:5},()=>randomUUID()),credential=randomUUID(),gameIds=Array.from({length:5},()=>randomUUID());
const days=['2026-10-14','2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-10-13','2026-10-12','2026-11-13','2026-11-16','2026-11-17','2026-11-18'];
async function cleanup(day){const runs=await query(db.database.from('bb_daily_runs').select('event_id').eq('day',day));for(const r of runs)await query(db.database.from('bb_outbox').delete().eq('event_id',r.event_id));await query(db.database.from('bb_daily_runs').delete().eq('day',day));}
async function call(token,method='GET',body){const response=await fetch(origin+'/api/v1/daily-preference'+(method==='GET'?'?token='+encodeURIComponent(token):''),{method,headers:{Origin:origin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
try {
 for(const day of days)await cleanup(day);
 const people=await query(db.database.from('bb_players').insert(ids.map((id,i)=>({id,email:prefix+i+'@useallowance.com',username:prefix+i,name:'Daily '+i,created_at:'2026-10-13T12:00:00Z'}))).select());assert(people.every(p=>p.daily_matchups));
 await query(db.database.from('bb_sessions').insert([{player_id:ids[0],token_hash:hash(credential),kind:'agent',label:'Daily test',expires_at:'2030-01-01T00:00:00Z'}]));
 const token=dailyToken(ids[0],config.otpSecret);assert.equal((await call(token)).data.enabled,true);assert.equal((await call(token)).data.enabled,true);
 assert.equal((await call(weeklyToken(ids[0],config.otpSecret))).status,401,'Weekly token cannot update daily preference');
 assert.equal((await call(token.slice(0,-2)+'xx')).status,401);assert.equal((await call(token,'POST',{token,enabled:true})).status,403);
 assert.equal((await call(token,'POST',{token,enabled:false})).data.enabled,false);
 const response=await fetch(origin+'/api/v1/daily-preference',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+credential},body:JSON.stringify({enabled:true,player:ids[1]})});assert.equal(response.status,200);
 const own=await(await fetch(origin+'/api/v1/state',{headers:{Authorization:'Bearer '+credential}})).json();assert.equal(own.user.dailyMatchups,true);assert(own.players.every(p=>!('dailyMatchups' in p)));
 await query(db.database.from('bb_players').update({daily_matchups:false}).eq('id',ids[2]));await query(db.database.from('bb_players').update({created_at:'2026-10-14T16:00:00Z'}).eq('id',ids[3]));
 await query(db.database.from('bb_daily_runs').insert([
   {day:'2026-10-13',cutoff:'2026-10-13T15:00:00Z',queued_at:'2026-10-13T15:00:01Z',snapshot:{players:people.map(p=>({id:p.id})),pairs:[[ids[0],ids[4]].sort()]}},
   {day:'2026-10-12',cutoff:'2026-10-12T15:00:00Z',queued_at:'2026-10-12T15:00:01Z',snapshot:{players:people.map(p=>({id:p.id})),pairs:[[ids[1],ids[4]].sort()]}}
 ]));
 await query(db.database.from('bb_games').insert(gameIds.map((id,i)=>({id,player1:ids[0],player2:i===3?ids[2]:ids[1],date:['2026-10-13','2026-09-15','2026-10-14','2026-10-13','2026-10-13'][i],matches:[{score1:11,score2:7},{score1:11,score2:8}],created_at:i===4?'2026-10-14T16:00:00Z':'2026-10-13T12:00:00Z'}))));
 await query(db.database.from('bb_games').update({matches:[{score1:7,score2:11},{score1:8,score2:11}]}).eq('id',gameIds[0]));
 await query(db.database.from('bb_activity').insert([
   {actor:ids[0],game_id:gameIds[0],action:'game.recorded',description:'Recap fixture original',created_at:'2026-10-13T12:00:00Z',after_data:{score1:2,score2:0}},
   {actor:ids[0],game_id:gameIds[0],action:'game.corrected',description:'Recap fixture after cutoff',created_at:'2026-10-14T15:30:00Z',after_data:{score1:0,score2:2}}
 ]));
 assert.equal(await rpc('bb_daily_snapshot',{p_now:'2026-10-14T14:59:59Z'}),null,'Not before 8 AM PDT');
 assert.equal(await rpc('bb_daily_snapshot',{p_now:'2026-10-17T15:00:00Z'}),null,'No Saturday send');assert.equal(await rpc('bb_daily_snapshot',{p_now:'2026-10-18T15:00:00Z'}),null,'No Sunday send');
 const snapshots=await Promise.all(Array.from({length:3},()=>rpc('bb_daily_snapshot',{p_now:'2026-10-14T15:00:00Z'})));assert.deepEqual(snapshots[0],snapshots[1]);
 const snapshot=snapshots[0];assert(!snapshot.players.some(p=>p.id===ids[2]||p.id===ids[3]),'Opted out / late signup are excluded');assert(snapshot.players.some(p=>p.id===ids[0]));assert.equal(snapshot.history.find(h=>[h.player1,h.player2].includes(ids[0])&&[h.player1,h.player2].includes(ids[1])).games,1,'Four-week window excludes old and same-day games');
 const recap=snapshot.yesterdayGames.filter(g=>gameIds.includes(g.id));
 assert.equal(recap.length,2,'Only yesterday games recorded before cutoff are included');
 assert.equal(recap.find(g=>g.id===gameIds[0]).score1,2,'Use result history at cutoff, not a later correction');
 assert(recap.some(g=>g.player2.id===ids[2]),'Recap includes public results of opted-out players');
 assert(recap.every(g=>g.player1.name&&g.player2.name));assert(!JSON.stringify(recap).includes('@useallowance.com'),'No emails in result snapshot');
 const hasExcluded=(a,b)=>snapshot.excludedPairs.some(pair=>pair.includes(a)&&pair.includes(b));
 assert(hasExcluded(ids[0],ids[1]),'Yesterday’s played pair is frozen as excluded');
 assert(hasExcluded(ids[0],ids[4]),'Yesterday’s queued recommendation is frozen as excluded');
 assert(!hasExcluded(ids[1],ids[4]),'Recommendations from two days ago are eligible again');
 const pairs=dailyPairs(snapshot);
 for(const pair of pairs)if(snapshot.excludedPairs.some(blocked=>JSON.stringify(blocked)===JSON.stringify(pair)))assert(pair.some(id=>snapshot.players.filter(p=>p.id!==id).every(other=>hasExcluded(id,other.id))),'Repeats require a player with no fresh options');
 await assert.rejects(()=>rpc('bb_queue_daily_matchups',{p_day:days[0],p_pairs:[[ids[0],ids[0]]]}),'Reject invalid lineup before any delivery queues');
 const candidates=[pairs,dailyPairs(snapshot),dailyPairs(snapshot)];const results=await Promise.all(candidates.map(candidate=>rpc('bb_queue_daily_matchups',{p_day:days[0],p_pairs:candidate})));const winningPairs=candidates[results.findIndex(n=>n>0)];assert.equal(results.filter(n=>n>0).length,1);
 const run=(await query(db.database.from('bb_daily_runs').select('*').eq('day',days[0])))[0];assert.deepEqual(run.snapshot.pairs,winningPairs);assert.deepEqual(run.snapshot.yesterdayGames,snapshot.yesterdayGames,'Results persist unchanged during queueing');assert.equal(Date.parse(run.cutoff),Date.parse('2026-10-14T15:00:00Z'));
 const outbox=await query(db.database.from('bb_outbox').select('recipient').eq('event_id',run.event_id));assert.equal(outbox.length,new Set(winningPairs.flat()).size,'Queue only players with an eligible opponent');assert(!outbox.some(o=>o.recipient===ids[2]||o.recipient===ids[3]));
 assert.equal(await rpc('bb_daily_snapshot',{p_now:'2026-10-14T15:30:00Z'}),null,'Restart cannot create a second lineup');
 assert.equal(await rpc('bb_daily_snapshot',{p_now:'2026-11-09T15:59:59Z'}),null,'PST before 8 AM');const winter=await rpc('bb_daily_snapshot',{p_now:'2026-11-09T16:00:00Z'});assert(!winter.yesterdayGames.some(g=>gameIds.includes(g.id)),'Empty yesterday has no fixture results');assert.equal(Date.parse(winter.cutoff),Date.parse('2026-11-09T16:00:00Z'));
 assert.equal(await rpc('bb_daily_snapshot',{p_now:'2026-11-10T18:00:00Z'}),null,'Skip stale catchup after 10 AM');
 for(const [index,n] of [[2,0],[3,1],[4,2]]) {
   const day=days[index],small={day,players:people.slice(0,n).map(p=>({id:p.id,name:p.name})),history:[],yesterdayGames:n===1?snapshot.yesterdayGames:[]};await query(db.database.from('bb_daily_runs').insert([{day,cutoff:day+'T16:00:00Z',snapshot:small}]));
   assert.equal(await rpc('bb_queue_daily_matchups',{p_day:day,p_pairs:dailyPairs(small)}),n===2?2:n===1?1:0,'Small roster sends recap only when there is no opponent');
 }
 const sparse={day:'2026-11-13',players:people.slice(0,3).map(p=>({id:p.id,name:p.name})),history:[],excludedPairs:[[ids[0],ids[2]].sort(),[ids[1],ids[2]].sort()]};
 await query(db.database.from('bb_daily_runs').insert([{day:sparse.day,cutoff:sparse.day+'T16:00:00Z',snapshot:sparse}]));
 assert.equal(await rpc('bb_queue_daily_matchups',{p_day:sparse.day,p_pairs:dailyPairs(sparse)}),2,'Partial lineup queues two one-opponent emails only');
 const none={...sparse,day:'2026-11-16',excludedPairs:[...sparse.excludedPairs,[ids[0],ids[1]].sort()]};
 await query(db.database.from('bb_daily_runs').insert([{day:none.day,cutoff:none.day+'T16:00:00Z',snapshot:none}]));assert.equal(await rpc('bb_queue_daily_matchups',{p_day:none.day,p_pairs:dailyPairs(none)}),2,'All blocked: opted-in players get mutual rematch emails');
 await query(db.database.from('bb_daily_runs').insert([{day:'2026-11-17',cutoff:'2026-11-17T16:00:00Z',snapshot:{day:'2026-11-17',players:sparse.players,history:[]}}]));
 const upgraded=await rpc('bb_daily_snapshot',{p_now:'2026-11-17T16:00:00Z'});assert(Array.isArray(upgraded.excludedPairs),'Pending old snapshots gain exclusions before pairing');
 const fresh={day:'2026-11-18',players:people.slice(0,4).map(p=>({id:p.id,name:p.name})),history:[],excludedPairs:[[ids[0],ids[1]].sort()]};
 await query(db.database.from('bb_daily_runs').insert([{day:fresh.day,cutoff:fresh.day+'T16:00:00Z',snapshot:fresh}]));
 await assert.rejects(()=>rpc('bb_queue_daily_matchups',{p_day:fresh.day,p_pairs:[[ids[0],ids[1]].sort()]}),'A rematch is rejected when both people have fresh options');
 console.log('Daily real-backend checks passed: signed/read-only preferences, default on, public privacy, PDT/PST, weekdays, two-hour catchup, cutoff roster/history, random reciprocal pairs, played/recommended exclusions, mutual rematch and recap-only fallbacks, frozen concurrent winners, pending snapshot upgrades and zero/one/two players. No emails sent.');
} finally {
 for(const day of days)await cleanup(day);
 await query(db.database.from('bb_activity').delete().in('actor',ids));await query(db.database.from('bb_games').delete().in('id',gameIds));await query(db.database.from('bb_sessions').delete().in('player_id',ids));await query(db.database.from('bb_players').delete().in('id',ids));
}
