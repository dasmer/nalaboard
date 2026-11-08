import assert from 'node:assert/strict';
import {matchScore,matchFormat} from '../series.mjs';
const win={score1:11,score2:7},loss={score1:9,score2:11},deuce={type:'deuce',winner:1};
for(const games of [[win,win],[loss,loss],[win,loss,deuce],[loss,win,loss]]) {
  const result=matchScore(games);
  assert.equal(result.games.length,games.length);
  assert.equal(Math.max(result.score1,result.score2),2);
}
for(const games of [undefined,[],[win,loss],[win,win,loss],[loss,loss,win],[win,loss,win,win],
  [win,{score1:11,score2:10}],[win,{score1:12,score2:7}],[win,{score1:13,score2:10}],
  [win,{score1:100,score2:98}],[win,{score1:11,score2:-1}],[win,{score1:'11',score2:9}],
  [win,{score1:11.5,score2:9.5}],[win,null]]) {
  assert.throws(()=>matchScore(games),e=>e.status===400);
}
assert.equal(matchScore([win,loss,deuce]).score1,2);
assert.equal(matchScore([win,loss,deuce]).score2,1);
assert.equal(matchScore([loss,loss]).score1,0);
console.log('Single-game and best-of-three series validation passed.');
const unknown={type:'unrecorded',winner:2};
assert.deepEqual(matchScore([win,unknown,deuce]),{games:[win,unknown,deuce],score1:2,score2:1});
assert.equal(matchScore([{type:'deuce',winner:2},unknown]).score2,2);
for(const m of [{type:'deuce'},{type:'deuce',winner:0},{type:'deuce',winner:3},{type:'deuce',winner:'1'},
  {type:'deuce',winner:1,score1:11},{type:'unrecorded',winner:2,score2:0},{type:'other',winner:1},
  {type:'exact',winner:1,score1:11,score2:7},{score1:13,score2:11},{score1:10,score2:10}])
  assert.throws(()=>matchScore([win,m]),e=>e.status===400);

for(const match of [win,loss,deuce,{type:'deuce',winner:2},{type:'unrecorded',winner:1},{type:'unrecorded',winner:2}]) {
  const result=matchScore([match]);
  assert.deepEqual([result.score1,result.score2],match.score1>match.score2||match.winner===1?[1,0]:[0,1]);
  assert.deepEqual(result.games,[match]);
  assert.equal(matchFormat(result.games),'Single-game match');
}
assert.equal(matchFormat([win,win]),'Best of three');
assert.equal(matchFormat([win,loss,deuce]),'Best of three');
for(const match of [null,{}, {score1:10,score2:10}, {type:'deuce'}, {type:'unrecorded',winner:3}])
  assert.throws(()=>matchScore([match]),e=>e.status===400);
