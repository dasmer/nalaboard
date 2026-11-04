import assert from 'node:assert/strict';
// Fake credentials and an intercepted transport: this test cannot send email.
Object.assign(process.env,{APP_ENV:'test',INSFORGE_URL:'http://localhost:1',INSFORGE_API_KEY:'fixture-only',
  RESEND_API_KEY:'re_fixture_only',EMAIL_TEST_RECIPIENTS:'inbox@example.test',EMAIL_TEST_SINK:'inbox@example.test'});
const sent=[];
globalThis.fetch=async(url,options)=>{
  assert.equal(String(url),'https://api.resend.com/emails');
  sent.push(JSON.parse(options.body));
  return new Response(JSON.stringify({id:'mock-message'}),{status:200,headers:{'Content-Type':'application/json'}});
};
const {db}=await import('../server/config.mjs');
const {sendOtp,deliverOutbox}=await import('../server/email.mjs');
const after={score1:2,score2:0,matches:[{score1:11,score2:7},{score1:11,score2:9}]};
const rows=[
  {id:'game-email',payload:{action:'game.recorded',gameId:'game',actor:'a',after}},
  {id:'comment-email',payload:{action:'comment.added',gameId:'game',actor:'a',text:'Nice game!',after}},
  {id:'agent-email',payload:{action:'agent.connected',actor:'b',label:'Codex'}},
].map(r=>({...r,recipient:'b',subject:'Fixture subject',attempts:0}));
db.database.rpc=async()=>({data:rows,error:null});
let gameLookups=0;const updates=[];
db.database.from=table=>{
  let ids=[],update;
  const chain={select(){return this},eq(){return this},in(key,value){ids=value;return this},limit(){return this},
    update(value){update=value;return this},then(resolve,reject){
      let data;
      if(table==='bb_games'){gameLookups++;data=[{player1:'a',player2:'b'}];}
      else if(table==='bb_players')data=[{id:'a',name:'Alex',email:'a@example.test'},{id:'b',name:'Jordan',email:'b@example.test'}].filter(p=>ids.includes(p.id));
      else {assert.equal(table,'bb_outbox');updates.push(update);data=[];}
      return Promise.resolve({data,error:null}).then(resolve,reject);
    }};
  return chain;
};
await sendOtp('user@example.test','012345','fixture-otp');
await deliverOutbox();
assert.equal(sent.length,4);
assert.ok(sent.every(m=>m.to==='inbox@example.test' && m.html && m.text));
assert.ok(sent[0].html.includes('012345'));
assert.ok(sent[1].html.includes('Alex') && sent[1].html.includes('Jordan'));
assert.ok(sent[2].html.includes('Nice game!'));
assert.ok(sent[3].text.includes('Manage agent connection:'));
assert.equal(gameLookups,1,'Comments and security notices need no extra game lookup');
assert.equal(updates.length,3);
assert.ok(updates.every(u=>u.sent_at && u.last_error===null));
console.log('Email delivery checks passed with mocked database and Resend transport; no emails sent.');
