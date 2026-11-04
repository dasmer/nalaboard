import {db,readQuery} from './config.mjs';
const playerFields='id,name,username,bio,avatar,color,image_key,created_at';
export const player=(p,account=false)=>({id:p.id,name:p.name,username:p.username,bio:p.bio,avatar:p.avatar,color:p.color,
  image:p.image_key?`/api/v1/photos/${p.id}`:null,...(account?{email:p.email,notifications:p.notifications,weeklyRecap:p.weekly_recap,dailyMatchups:p.daily_matchups}:{})});
const event=(e)=>({id:e.id,actor:e.actor,gameId:e.game_id,action:e.action,text:e.description,agent:e.agent,
  before:e.before_data,after:e.after_data,createdAt:e.created_at});
const publicResult=value=>value && Object.fromEntries(['score1','score2','matches','notes'].filter(key=>key in value).map(key=>[key,value[key]]));
export async function state(identity,requestedGame=null,cursors={},requestedPlayer=null) {
  const [people,games,events,keys,totals]=await Promise.all([
    readQuery(()=>db.database.from('bb_players').select(playerFields).order('username').limit(1000)),
    readQuery(()=>db.database.rpc('bb_page_games_played',{p_player:requestedPlayer,p_date:cursors.games?.[2] || null,p_time:cursors.games?.[0] || null,p_id:cursors.games?.[1] || null})),
    identity ? readQuery(()=>db.database.rpc('bb_page_activity',{p_time:cursors.activity?.[0] || null,p_id:cursors.activity?.[1] || null})) : [],
    identity ? readQuery(()=>db.database.from('bb_sessions').select('id,label,created_at,expires_at').eq('player_id',identity.user.id).eq('kind','agent').is('revoked_at',null).gt('expires_at',new Date().toISOString()).limit(100)) : [],
    readQuery(()=>db.database.rpc('bb_standings',{}))
  ]);
  const cursor=(rows,played=false)=>rows.length===100 ? Buffer.from(JSON.stringify([rows.at(-1).created_at,rows.at(-1).id,...(played?[rows.at(-1).date]:[])])).toString('base64url') : null;
  const pagination={games:cursor(games,true),activity:cursor(events)};
  if (requestedGame && !games.some(g=>g.id===requestedGame)) {
    const extra=await readQuery(()=>db.database.from('bb_games').select('id,player1,player2,score1,score2,matches,date,notes,revision,created_at').eq('id',requestedGame).limit(1));
    games.push(...extra);
  }
  const ids=games.map(g=>g.id);
  const {comments,reactions,history,subscriptions}=await readQuery(()=>db.database.rpc('bb_game_content',{p_games:ids,p_player:identity?.user.id || null}));
  return {...totals,pagination,players:people.map(p=>player(p)),user:identity ? player(identity.user,true) : null,keys:keys.map(k=>({id:k.id,label:k.label,createdAt:k.created_at,expiresAt:k.expires_at})),
    activity:events.map(event),games:games.map(g=>({id:g.id,player1:g.player1,player2:g.player2,score1:g.score1,score2:g.score2,matches:g.matches,date:g.date,notes:g.notes,
      revision:g.revision,actor:g.player1,createdAt:g.created_at,history:history.filter(e=>e.game_id===g.id).map(e=>identity ? event(e) : {...event(e),before:publicResult(e.before_data),after:publicResult(e.after_data)}),
      comments:comments.filter(c=>c.game_id===g.id).map(c=>({id:c.id,actor:c.player_id,text:c.text,mentions:c.mentions,agent:c.agent,createdAt:c.created_at})),
      reactions:reactions.filter(r=>r.game_id===g.id).reduce((a,r)=>{(a[r.emoji] ||= []).push(r.player_id);return a;},{}),
      ...(identity ? {subscribed:subscriptions.some(s=>s.game_id===g.id),muted:subscriptions.find(s=>s.game_id===g.id)?.muted || false} : {})}))};
}
