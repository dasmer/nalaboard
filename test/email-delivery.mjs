import assert from 'node:assert/strict';
// Fake credentials and an intercepted transport: this test cannot send email.
Object.assign(process.env,{APP_ENV:'test',INSFORGE_URL:'http://localhost:1',INSFORGE_API_KEY:'fixture-only',
  RESEND_API_KEY:'re_fixture_only',EMAIL_TEST_RECIPIENTS:'inbox@example.test',EMAIL_TEST_SINK:'inbox@example.test'});
let inactive=false,canceled=false;
const sent=[];
globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'https://api.resend.com/emails');
  sent.push(JSON.parse(options.body));
  return new Response(JSON.stringify({id:'mock-message'}),{status:200,headers:{'Content-Type':'application/json'}});
};
const {db}=await import('../server/config.mjs');
const {sendOtp,deliverOutbox}=await import('../server/email.mjs');
const after={score1:2,score2:0,games:[{score1:11,score2:7},{score1:11,score2:9}]};
const rows=[
  {id:'game-email',payload:{action:'match.recorded',matchId:'game',actor:'a',after}},
  {id:'comment-email',payload:{action:'comment.added',matchId:'game',actor:'a',text:'Nice game!',after}},
  {id:'agent-email',payload:{action:'agent.connected',actor:'b',label:'Codex'}},
].map(r=>({...r,recipient:'b',subject:'A new match is on the board',attempts:0}));
rows.push(...['a','b'].map(recipient=>({id:`display-${recipient}`,recipient,subject:'A new match is on the board',attempts:0,payload:{action:'match.recorded',matchId:'display-game',actor:'a',display:true,after}})));
db.database.rpc=async()=>({data:rows,error:null});
let gameLookups=0;const updates=[];
db.database.from=table=>{
  let ids=[],update;
  const chain={select(){return this},eq(){return this},in(key,value){ids=value;return this},limit(){return this},
    update(value){update=value;return this},then(resolve,reject){
      let data;
      if(table==='nb_matches'){gameLookups++;data=[{player1:'a',player2:'b'}];}
      else if(table==='nb_players')data=[{id:'a',name:'Alex',email:'a@example.test'},{id:'b',name:'Jordan',email:'b@example.test'}].filter(p=>ids.includes(p.id)).map(p=>({...p,active:p.id==='b'?!inactive:true}));
      else {assert.equal(table,'nb_outbox');if(update){updates.push(update);data=[];}else data=[{sent_at:canceled?new Date().toISOString():null}];}
      return Promise.resolve({data,error:null}).then(resolve,reject);
    }};
  return chain;
};
await sendOtp('user@example.test','012345','fixture-otp');
await deliverOutbox();
assert.equal(sent.length,6);
assert.ok(sent.every(m=>m.to==='inbox@example.test' && m.html && m.text));
assert.ok(sent[0].html.includes('012345'));
assert.ok(sent[1].html.includes('Alex') && sent[1].html.includes('Jordan'));
assert.ok(sent[2].html.includes('Nice game!'));
assert.ok(sent[3].text.includes('Manage agent connection:'));
assert.ok(sent[4].text.includes('You won 2–0 against Jordan.'));
assert.ok(sent[5].text.includes('You lost 0–2 against Alex.'));
assert.ok(sent.slice(4).every(m=>m.text.includes('Recorded by Alex on the office big screen.')));
assert.equal(sent[4].subject,'Your match against Jordan is on the board');
assert.equal(sent[5].subject,'Your match against Alex is on the board');
assert.equal(gameLookups,3,'Comments and security notices need no extra game lookup');
assert.equal(updates.length,5);
assert.ok(updates.every(u=>u.sent_at && u.last_error===null));
console.log('Email delivery checks passed with mocked database and Resend transport; no emails sent.');

rows.splice(0,rows.length,{id:'cancel-fixture',recipient:'b',payload:{action:'match.recorded',matchId:'game',actor:'a',after},subject:'Fixture',attempts:0});
inactive=true;await deliverOutbox();assert.equal(sent.length,6,'Inactive recipients receive no email');
inactive=false;canceled=true;await deliverOutbox();assert.equal(sent.length,6,'Reactivation never revives a canceled, previously claimed email');
console.log('Offboarding delivery passed: inactive suppression and canceled-claim protection after reactivation.');
