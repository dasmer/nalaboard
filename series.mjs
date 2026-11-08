export const gameWinner = m => (m.type === 'deuce' || m.type === 'unrecorded') ? m.winner : m.score1 > m.score2 ? 1 : 2;
export function gameLabel(m,names=['Player 1','Player 2']) {
  if(m.type==='deuce')return `${names[m.winner-1]} won in deuce`;
  if(m.type==='unrecorded')return `${names[m.winner-1]} won · Score not recorded`;
  return `${m.score1}–${m.score2}`;
}
export const matchFormat = games => games.length === 1 ? 'Single-game match' : 'Best of three';
export function matchScore(games) {
  const fail = message => { throw Object.assign(new Error(message), {status:400}); };
  if (!Array.isArray(games) || games.length < 1 || games.length > 3) fail('Record one game for a single-game match, or two or three for best of three.');
  let score1=0, score2=0;
  for (const [i,game] of games.entries()) {
    if (score1===2 || score2===2) fail('The match ends after two game wins. Do not record another game.');
    if(!game || typeof game!=='object' || Array.isArray(game))fail(`Game ${i+1}: choose a result.`);
    const type=game.type??'exact';
    if(type==='exact') {
      const a=game.score1,b=game.score2;
      if(!Number.isInteger(a)||!Number.isInteger(b)||Math.min(a,b)<0||Math.max(a,b)!==11||Math.min(a,b)>9||game.winner!==undefined)fail(`Game ${i+1}: exact scores finish at 11–0 through 11–9. Reached deuce? Choose Deuce finish and who won.`);
    } else if(!['deuce','unrecorded'].includes(type)||![1,2].includes(game.winner)||game.score1!==undefined||game.score2!==undefined)fail(`Game ${i+1}: choose who won, without numerical scores.`);
    if (gameWinner(game)===1) score1++; else score2++;
  }
  if (Math.max(score1,score2)!==(games.length===1?1:2)) fail('The match is not finished. Add the deciding game.');
  return {games:games.map(m=>m.type==='deuce'||m.type==='unrecorded'?{type:m.type,winner:m.winner}:{score1:m.score1,score2:m.score2}),score1,score2};
}
