import assert from 'node:assert/strict';
import {dailyPairs,dailyEmail,dailyToken,dailyTokenPlayer} from '../server/daily-matchups.mjs';
import {weeklyToken} from '../server/weekly-recap.mjs';
const id=i=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`;
const players=Array.from({length:6},(_,i)=>({id:id(i),name:'Player '+i,avatar:'🏓'}));
const rng=(seed=1)=>upper=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%upper;};
for(let n=0;n<=40;n++)for(let seed=1;seed<=5;seed++) {
 const roster=Array.from({length:n},(_,i)=>({id:id(i)})),s={day:'2026-10-14',players:roster,history:[],excludedPairs:[]},pairs=dailyPairs(s,rng(seed));
 const degree=new Map(roster.map(p=>[p.id,0]));
 for(const pair of pairs){assert.notEqual(pair[0],pair[1]);for(const p of pair)degree.set(p,degree.get(p)+1);}
 assert.equal(new Set(pairs.map(p=>p.join(':'))).size,pairs.length);
 assert([...degree.values()].every(d=>d===Math.min(2,Math.max(0,n-1))));
 assert.deepEqual(dailyPairs({...s,players:[...roster].reverse()},rng(seed)),pairs,'Reproducible with injected random source regardless of input order');
}
const s={day:'2026-10-14',players:players.slice(0,4),history:[],excludedPairs:[]},pairs=dailyPairs(s,rng());
const blocked={...s,history:[{player1:id(0),player2:id(1),games:1,lastPlayed:'2026-10-13'}],excludedPairs:[[id(3),id(2)]]};
for(let seed=1;seed<=50;seed++) {
 const result=dailyPairs(blocked,rng(seed));assert(!result.some(p=>p.join(':')===[id(0),id(1)].join(':')),'Never repeat yesterday’s played opponent');assert(!result.some(p=>p.join(':')===[id(2),id(3)].join(':')),'Never repeat yesterday’s recommendation');
}
const two={...s,players:s.players.slice(0,2)};
assert.deepEqual(dailyPairs({...two,excludedPairs:[[id(0),id(1)]]}),[[id(0),id(1)]],'No fresh choices gives one mutual rematch');
assert.equal(dailyPairs({...two,history:[{player1:id(0),player2:id(1),games:99,lastPlayed:'2026-10-12'}]}).length,1,'Older games do not block a random matchup');
const sparse={...s,excludedPairs:[[id(0),id(2)],[id(0),id(3)],[id(1),id(2)],[id(1),id(3)],[id(2),id(3)]]};
assert(dailyPairs(sparse,rng()).flat().includes(id(2)),'A stranded player gets a mutual fallback');
const variants=new Set(Array.from({length:20},(_,i)=>JSON.stringify(dailyPairs(s,rng(i+1)))));assert(variants.size>1,'Different random draws produce different eligible lineups');
assert.deepEqual(dailyPairs({...s,history:[{player1:id(0),player2:id(1),games:100,lastPlayed:'2026-10-01'}]},rng()),pairs,'Historical counts no longer weight the random selection');
for(let n=2;n<=10;n++)for(let seed=1;seed<=10;seed++) {
 const roster=Array.from({length:n},(_,i)=>({id:id(i)})),draw=rng(seed),excludedPairs=roster.flatMap((a,i)=>roster.slice(i+1).filter(()=>draw(100)<45).map(b=>[a.id,b.id]));
 const randomSnapshot={day:s.day,players:roster,history:[],excludedPairs},result=dailyPairs(randomSnapshot,rng(seed)),degree=new Map(roster.map(p=>[p.id,0]));
 for(const [a,b] of result){assert.notEqual(a,b);if(excludedPairs.some(pair=>pair.includes(a)&&pair.includes(b)))assert([a,b].some(person=>roster.filter(p=>p.id!==person).every(other=>excludedPairs.some(pair=>pair.includes(person)&&pair.includes(other.id)))),'Repeats only connect someone with no fresh options');degree.set(a,degree.get(a)+1);degree.set(b,degree.get(b)+1);}
 assert([...degree.values()].every(d=>d<=2));assert.equal(new Set(result.map(p=>p.join(':'))).size,result.length);
}
const token=dailyToken(id(0),'key');assert.equal(dailyTokenPlayer(token,'key'),id(0));assert.equal(dailyTokenPlayer(token,'wrong'),null);assert.equal(dailyTokenPlayer(weeklyToken(id(0),'key'),'key'),null,'Weekly links cannot alter daily preferences');
const snapshot={...s,pairs,players:s.players.map(p=>({...p,name:'<b>'+p.name}))};
const email=dailyEmail({snapshot,recipientId:id(0),origin:'https://burntboard.com',key:'key'});
assert.equal(email.subject,'🏓 <b>Player & <b>Player are your two today');assert(email.html.includes('&lt;b&gt;'));assert(!email.html.includes('<b>Player'));assert(email.html.includes('daily-emails/'));assert(email.text.includes('A fresh matchup—no games together in four weeks.'));
const opponent=pairs.find(p=>p.includes(id(0))).find(p=>p!==id(0));
for(const [lastPlayed,expected] of [['2026-10-13','Run it back.'],['2026-10-02','Time to catch up—last played 12 days ago.']]) {
 const recent=dailyEmail({snapshot:{...snapshot,history:[{player1:id(0),player2:opponent,games:2,lastPlayed}]},recipientId:id(0),origin:'https://burntboard.com',key:'key'});
 assert(recent.html.includes(expected));assert(recent.text.includes(expected),'Relative copy uses the frozen lineup date');
}
assert.equal(dailyEmail({snapshot,recipientId:id(0),origin:'https://burntboard.com',key:'key',activeIds:[]}),null);
const one=dailyEmail({snapshot,recipientId:id(0),origin:'https://burntboard.com',key:'key',activeIds:[pairs.find(p=>p.includes(id(0))).find(p=>p!==id(0))]});assert.equal(one.subject,'🏓 <b>Player is your matchup today');
console.log('Daily pairing checks passed: reciprocal two-opponent lineups, small/odd/even rosters, fresh-first exclusions, random variation, rematch and recap-only fallbacks, scoped tokens and escaped emails.');

const named={...snapshot,players:snapshot.players.map((p,i)=>({...p,name:i===0?'Dasmer Singh':i===1?'JJ Kumar':i===2?'RJ Sharma':'Jay Smith'}))};
const namedEmail=dailyEmail({snapshot:named,recipientId:id(0),origin:'https://burntboard.com',key:'key'});
assert.equal(namedEmail.subject,'🏓 '+pairs.filter(p=>p.includes(id(0))).map(p=>named.players.find(x=>x.id===p.find(x=>x!==id(0))).name.split(' ')[0]).join(' & ')+' are your two today');
assert(namedEmail.html.includes('Wednesday, October 14'));
for(const noisy of ['Best of three','Suggestions, not assignments','Your opponents got the same','Open the page, then tap']) {assert(!namedEmail.html.includes(noisy));assert(!namedEmail.text.includes(noisy));}

assert(!namedEmail.html.includes('Yesterday at the table'),'Omit empty recap for prior snapshots');
assert(!dailyEmail({snapshot:{...named,yesterdayGames:[]},recipientId:id(0),origin:'https://burntboard.com',key:'key'}).html.includes('Yesterday at the table'));
const resultPlayer={id:id(5),name:'<script>Other Player',avatar:'<x>',image:'/api/v1/photos/'+id(5)};
const withResults={...named,yesterdayGames:[{id:'game-a',player1:named.players[0],player2:resultPlayer,score1:2,score2:1},{id:'game-b',player1:resultPlayer,player2:named.players[0],score1:0,score2:2}]};
const recapEmail=dailyEmail({snapshot:withResults,recipientId:id(0),origin:'https://burntboard.com',key:'key'});
assert(recapEmail.html.includes('Yesterday at the table'));assert(recapEmail.html.indexOf('Yesterday at the table')>recapEmail.html.indexOf('View player'));
assert(recapEmail.html.includes('&lt;script&gt;Other Player'));assert(!recapEmail.html.includes('<script>'));assert(recapEmail.html.includes('/api/v1/photos/'+id(5)));
assert(recapEmail.html.includes('/#match/game-a'));assert(recapEmail.html.includes('/#match/game-b'));assert(recapEmail.text.includes('Dasmer Singh 2–1 <script>Other Player'));
assert(!recapEmail.html.includes('Match 1'),'Recap contains series totals only');assert.equal(recapEmail.subject,namedEmail.subject,'Recap does not change opponent subject');

for(let n=2;n<=9;n++) {
 const roster=players.slice(0,n).length===n?players.slice(0,n):Array.from({length:n},(_,i)=>({id:id(i),name:'Player '+i}));
 const excludedPairs=roster.flatMap((a,i)=>roster.slice(i+1).map(b=>[a.id,b.id])),allRematches=dailyPairs({...s,players:roster,excludedPairs},rng());
 for(const p of roster){const count=allRematches.filter(pair=>pair.includes(p.id)).length;assert(count>=1&&count<=2,'All-blocked even/odd pools remain covered and capped');}
}
const single={...named,players:[named.players[0]],pairs:[],yesterdayGames:withResults.yesterdayGames};
const recapOnly=dailyEmail({snapshot:single,recipientId:id(0),origin:'https://burntboard.com',key:'key'});assert.equal(recapOnly.subject,'🏓 Yesterday at the table · Burntboard');assert(!recapOnly.html.includes('View player'));assert(recapOnly.text.includes('Dasmer Singh 2–1'));assert.equal(dailyEmail({snapshot:{...single,yesterdayGames:[]},recipientId:id(0),origin:'https://burntboard.com',key:'key'}),null);
const rerun=dailyEmail({snapshot:{...two,pairs:[[id(0),id(1)]],excludedPairs:[[id(0),id(1)]]},recipientId:id(0),origin:'https://burntboard.com',key:'key'});assert(rerun.html.includes('Run it back.'));assert(rerun.text.includes('Run it back.'));

const withStranded={...s,players:players.slice(0,5),excludedPairs:players.slice(0,4).map(p=>[p.id,id(4)].sort())};
for(let seed=1;seed<=10;seed++) {
 const result=dailyPairs(withStranded,rng(seed));assert.equal(result.filter(pair=>pair.includes(id(4))).length,1,'One isolated player gets a rematch even when everyone else starts full');
 for(const p of withStranded.players)assert(result.filter(pair=>pair.includes(p.id)).length<=2);
}
