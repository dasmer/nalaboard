import {db,readQuery} from './config.mjs';
const playerFields='id,name,username,bio,avatar,color,image_key,created_at';
export const player=(p,account=false)=>({id:p.id,name:p.name,username:p.username,bio:p.bio,avatar:p.avatar,color:p.color,
  image:p.image_key?`/api/v1/photos/${p.id}`:null,...(account?{email:p.email,notifications:p.notifications,weeklyRecap:p.weekly_recap,dailyMatchups:p.daily_matchups}:{})});
const event=(e)=>({id:e.id,actor:e.actor,matchId:e.match_id,action:e.action,text:e.display_id && e.action==='match.recorded' ? 'Recorded on the office big screen' : e.description,agent:e.agent,
  before:e.before_data,after:e.after_data,createdAt:e.created_at,...(e.display_id?{display:true}:{})});
const publicResult=value=>value && Object.fromEntries(['score1','score2','games','notes'].filter(key=>key in value).map(key=>[key,value[key]]));
export async function state(identity,requestedMatch=null,cursors={},requestedPlayer=null) {
  const [people,matchResults,events,keys,totals]=await Promise.all([
    readQuery(()=>db.database.from('nb_players').select(playerFields).order('username').limit(1000)),
    readQuery(()=>db.database.rpc('nb_page_matches_played',{p_player:requestedPlayer,p_date:cursors.matches?.[2] || null,p_time:cursors.matches?.[0] || null,p_id:cursors.matches?.[1] || null})),
    identity ? readQuery(()=>db.database.rpc('nb_page_activity',{p_time:cursors.activity?.[0] || null,p_id:cursors.activity?.[1] || null})) : [],
    identity ? readQuery(()=>db.database.from('nb_sessions').select('id,label,created_at,expires_at').eq('player_id',identity.user.id).eq('kind','agent').is('revoked_at',null).gt('expires_at',new Date().toISOString()).limit(100)) : [],
    readQuery(()=>db.database.rpc('nb_standings',{}))
  ]);
  const cursor=(rows,played=false)=>rows.length===100 ? Buffer.from(JSON.stringify([rows.at(-1).created_at,rows.at(-1).id,...(played?[rows.at(-1).date]:[])])).toString('base64url') : null;
  const pagination={matches:cursor(matchResults,true),activity:cursor(events)};
  if (requestedMatch && !matchResults.some(g=>g.id===requestedMatch)) {
    const extra=await readQuery(()=>db.database.from('nb_matches').select('id,player1,player2,score1,score2,games,date,notes,revision,created_at').eq('id',requestedMatch).limit(1));
    matchResults.push(...extra);
  }
  const ids=matchResults.map(g=>g.id);
  const {comments,reactions,history,subscriptions}=await readQuery(()=>db.database.rpc('nb_match_content',{p_matches:ids,p_player:identity?.user.id || null}));
  return {...totals,pagination,players:people.map(p=>player(p)),user:identity ? player(identity.user,true) : null,keys:keys.map(k=>({id:k.id,label:k.label,createdAt:k.created_at,expiresAt:k.expires_at})),
    activity:events.map(event),matches:matchResults.map(g=>({id:g.id,player1:g.player1,player2:g.player2,score1:g.score1,score2:g.score2,games:g.games,date:g.date,notes:g.notes,
      revision:g.revision,actor:g.player1,createdAt:g.created_at,history:history.filter(e=>e.match_id===g.id).map(e=>identity ? event(e) : {...event(e),before:publicResult(e.before_data),after:publicResult(e.after_data)}),
      comments:comments.filter(c=>c.match_id===g.id).map(c=>({id:c.id,actor:c.player_id,text:c.text,mentions:c.mentions,agent:c.agent,createdAt:c.created_at})),
      reactions:reactions.filter(r=>r.match_id===g.id).reduce((a,r)=>{(a[r.emoji] ||= []).push(r.player_id);return a;},{}),
      ...(identity ? {subscribed:subscriptions.some(s=>s.match_id===g.id),muted:subscriptions.find(s=>s.match_id===g.id)?.muted || false} : {})}))};
}
