export const matchWinner = m => (m.type === 'deuce' || m.type === 'unrecorded') ? m.winner : m.score1 > m.score2 ? 1 : 2;
export function matchLabel(m,names=['Player 1','Player 2']) {
  if(m.type==='deuce')return `${names[m.winner-1]} won in deuce`;
  if(m.type==='unrecorded')return `${names[m.winner-1]} won · Score not recorded`;
  return `${m.score1}–${m.score2}`;
}
export function seriesScore(matches) {
  const fail = message => { throw Object.assign(new Error(message), {status:400}); };
  if (!Array.isArray(matches) || matches.length < 2 || matches.length > 3) fail('Record two or three matches for a best-of-three game.');
  let score1=0, score2=0;
  for (const [i,match] of matches.entries()) {
    if (score1===2 || score2===2) fail('The game ends after two match wins. Do not record another match.');
    if(!match || typeof match!=='object' || Array.isArray(match))fail(`Match ${i+1}: choose a result.`);
    const type=match.type??'exact';
    if(type==='exact') {
      const a=match.score1,b=match.score2;
      if(!Number.isInteger(a)||!Number.isInteger(b)||Math.min(a,b)<0||Math.max(a,b)!==11||Math.min(a,b)>9||match.winner!==undefined)fail(`Match ${i+1}: exact scores finish at 11–0 through 11–9. Reached deuce? Choose Deuce finish and who won.`);
    } else if(!['deuce','unrecorded'].includes(type)||![1,2].includes(match.winner)||match.score1!==undefined||match.score2!==undefined)fail(`Match ${i+1}: choose who won, without numerical scores.`);
    if (matchWinner(match)===1) score1++; else score2++;
  }
  if (Math.max(score1,score2)!==2) fail('The game is not finished. Add the deciding match.');
  return {matches:matches.map(m=>m.type==='deuce'||m.type==='unrecorded'?{type:m.type,winner:m.winner}:{score1:m.score1,score2:m.score2}),score1,score2};
}
