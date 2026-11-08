import {db,readQuery,rpc} from './config.mjs';
import {error} from './auth.mjs';

export async function isPlayerAdmin(who) {
  if(!who || who.session.kind!=='web' || who.user.active===false)return false;
  return (await readQuery(()=>db.database.from('nb_player_admins').select('player_id').eq('player_id',who.user.id).limit(1))).length>0;
}
export async function setPlayerActive(who,id,body) {
  if(!who)throw error('Sign in to manage players.',401);
  if(typeof body.active!=='boolean')throw error('Choose an account status.');
  return rpc('nb_set_player_active',{p_token:who.tokenHash,p_player:id,p_active:body.active});
}
