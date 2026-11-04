import assert from 'node:assert/strict';
Object.assign(process.env,{APP_ENV:'test',INSFORGE_URL:'http://localhost:1',INSFORGE_API_KEY:'fixture-only'});
globalThis.fetch=()=>{throw Error('This test must never reach a backend.');};
const {db}=await import('../server/config.mjs');
const {state}=await import('../server/state.mjs');
const user={id:'a',name:'Alex',username:'alex',bio:'Loves ping pong',avatar:'🏓',image_key:'private-storage-path',email:'private@example.test',notifications:false};
const game={id:'game',player1:'a',player2:'b',score1:2,score2:0,matches:[{score1:11,score2:7},{score1:11,score2:9}],date:'2026-10-12',notes:'Public note',revision:1};
const calls=[];
db.database.from=table=>{
 calls.push(table);
 const chain={select(){return this},order(){return this},eq(){return this},limit(){return this},is(){return this},gt(){return this},
  then(resolve,reject){return Promise.resolve({data:table==='bb_players'?[user]:table==='bb_sessions'?[{id:'key',label:'Codex',token_hash:'PRIVATE_KEY_HASH'}]:[game],error:null}).then(resolve,reject);}};
 return chain;
};
db.database.rpc=async(name,args)=>{
 calls.push(name);
 const data=name==='bb_page_games_played'?[game]:name==='bb_page_activity'?[{action:'agent.connected',after_data:{email:user.email}}]:name==='bb_standings'?{standings:{all:[{id:'a',wins:1}]}}:{
  comments:[{id:'c',game_id:'game',player_id:'b',text:'Public comment',mentions:['a'],deleted_at:null}],
  reactions:[{game_id:'game',player_id:'b',emoji:'🔥'}],
  history:[{id:'e',actor:'a',game_id:'game',action:'game.recorded',description:'Recorded game',after_data:{score1:2,score2:0,matches:game.matches,notes:game.notes,email:user.email,token_hash:'PRIVATE_KEY_HASH'}}],
  subscriptions:[{game_id:'game',player_id:'a',muted:true}],
 };
 if(name==='bb_game_content' && !args.p_player)assert.equal(args.p_player,null);
 return {data,error:null};
};
const publicState=await state(null);
assert.equal(publicState.user,null);assert.deepEqual(publicState.keys,[]);assert.deepEqual(publicState.activity,[]);
assert.equal(publicState.players[0].bio,user.bio);assert.equal(publicState.players[0].image,'/api/v1/photos/a');
assert.equal(publicState.games[0].notes,game.notes);assert.equal(publicState.games[0].comments[0].text,'Public comment');
assert.deepEqual(publicState.games[0].reactions,{'🔥':['b']});
assert.equal('muted' in publicState.games[0],false);assert.equal('subscribed' in publicState.games[0],false);
assert.equal(calls.includes('bb_sessions'),false);assert.equal(calls.includes('bb_page_activity'),false);
assert.equal(JSON.stringify(publicState).includes('private@example.test'),false);
assert.equal(JSON.stringify(publicState).includes('PRIVATE_KEY_HASH'),false);
assert.equal(JSON.stringify(publicState).includes('private-storage-path'),false);
const signedIn=await state({user});
assert.equal(signedIn.user.email,user.email);assert.equal(signedIn.user.notifications,false);
assert.equal('email' in signedIn.players[0],false);assert.equal(signedIn.games[0].muted,true);
assert.equal(signedIn.keys[0].label,'Codex');assert.equal('token_hash' in signedIn.keys[0],false);
assert.equal(calls.includes('bb_sessions'),true);
console.log('Public state checks passed: social reads, public photo URLs, private account/history/subscription fields excluded, authenticated state preserved.');
