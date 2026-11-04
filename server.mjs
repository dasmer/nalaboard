import {weeklyTokenPlayer} from './server/weekly-recap.mjs';
import {dailyTokenPlayer} from './server/daily-matchups.mjs';
import http from 'node:http';
import {seriesScore} from './series.mjs';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import sharp from 'sharp';
import {config,db,query,readQuery,rpc} from './server/config.mjs';
import {identity,error,requestCode,verifyCode,cookie,hash,secret} from './server/auth.mjs';
import {state} from './server/state.mjs';
import {deliverOutbox,queueWeeklyRecap,queueDailyMatchups} from './server/email.mjs';
import {gameShareURL,serveGameShare} from './game-share.mjs';
import {checkProxy,clientIp} from './server/proxy.mjs';
const root=resolve('.');
const allowed=new Set(['/index.html','/client.js','/client.css','/favicon.svg','/agent.md','/series.mjs']);
const mime={'.mjs':'text/javascript; charset=utf-8','.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.md':'text/markdown; charset=utf-8'};
async function jsonBody(req) {
  const chunks=[];let size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>3000000) throw error('Photo is too large.',413);chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8');
  try {return raw?JSON.parse(raw):{};} catch {throw error('Invalid JSON.');}
}
const uuid=(value)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
async function loadSharedGame(id) {
  if(!uuid(id))return null;
  const game=(await readQuery(()=>db.database.from('bb_games').select('id,player1,player2,score1,score2,matches,date,revision').eq('id',id).limit(1)))[0];
  if(!game)return null;
  const players=await readQuery(()=>db.database.from('bb_players').select('id,name').in('id',[game.player1,game.player2]).limit(2));
  return {game,players};
}
function checkOrigin(req) {
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    const bearer=!!req.headers.authorization;
    if (req.headers.origin && req.headers.origin!==config.origin) throw error('Request origin is not allowed.',403);
    if (!bearer && req.headers.cookie && req.headers.origin!==config.origin) throw error('Browser writes require a matching origin.',403);
    if (req.headers['sec-fetch-site']==='cross-site') throw error('Cross-site requests are not allowed.',403);
  }
}
async function api(req,res,url) {
  checkOrigin(req);
  const body=await jsonBody(req), path=url.pathname.slice('/api/v1'.length);
  if(req.method==='POST' && path==='/auth/request') {
    return requestCode(body,clientIp(req,config.trustProxy));
  }
  if(req.method==='POST' && path==='/auth/verify') return verifyCode(body,res);
  const who=await identity(req);
  if(req.method==='GET' && path==='/state') {
    const game=url.searchParams.get('game');
    if(game && !uuid(game)) throw error('Invalid game.');
    const player=url.searchParams.get('player');
    if(player && !uuid(player)) throw error('Invalid player.');
    const cursors={};
    for(const kind of ['games','activity']) {
      const input=url.searchParams.get(kind+'Before');
      if(input) {
        let cursor;try{cursor=JSON.parse(Buffer.from(input,'base64url'));}catch{throw error('Invalid page cursor.');}
        if(!Array.isArray(cursor) || cursor.length!==(kind==='games'?3:2) || !uuid(cursor[1]) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor[0])) throw error('Invalid page cursor.');
        if(kind==='games' && !/^\d{4}-\d{2}-\d{2}$/.test(cursor[2])) throw error('Invalid page cursor.');
        cursors[kind]=cursor;
      }
    }
    return state(who,game,cursors,player);
  }
  if(['/weekly-preference','/daily-preference'].includes(path) && ['GET','POST'].includes(req.method)) {
    const daily=path==='/daily-preference',field=daily?'daily_matchups':'weekly_recap';
    const token=req.method==='GET'?url.searchParams.get('token'):body.token;
    const target=token?(daily?dailyTokenPlayer:weeklyTokenPlayer)(token,config.otpSecret):who?.user.id;
    if(!target)throw error('This preference link is invalid. Sign in to manage your emails.',401);
    if(req.method==='POST') {
      if(typeof body.enabled!=='boolean')throw error('Choose an email preference.');
      if(token && body.enabled!==false)throw error('Sign in to subscribe again.',403);
      return rpc(daily?'bb_daily_preference':'bb_weekly_preference',{p_player:target,p_enabled:body.enabled});
    }
    const rows=await readQuery(()=>db.database.from('bb_players').select(field).eq('id',target).limit(1));
    if(!rows.length)throw error('Player not found.',404);
    return {enabled:rows[0][field]};
  }
  const photo=/^\/photos\/([^/]+)$/.exec(path);
  if(photo && req.method==='GET') {
    if(!uuid(photo[1])) throw error('Photo not found.',404);
    const rows=await readQuery(()=>db.database.from('bb_players').select('image_key').eq('id',photo[1]).limit(1));
    if(!rows[0]?.image_key) throw error('Photo not found.',404);
    const blob=await readQuery(()=>db.storage.from('player-photos').download(rows[0].image_key));
    res.setHeader('Content-Type','image/webp');res.end(Buffer.from(await blob.arrayBuffer()));return null;
  }
  if(!who) throw error('Sign in to continue.',401);
  const share=/^\/games\/([^/]+)\/share$/.exec(path);
  if(share && req.method==='GET') {
    if(!uuid(share[1]))throw error('Game not found.',404);
    const found=await loadSharedGame(share[1]);
    if(!found)throw error('Game not found.',404);
    if(![found.game.player1,found.game.player2].includes(who.user.id))throw error('Only participants can share this game.',403);
    return {url:gameShareURL({origin:config.origin,id:share[1],key:config.otpSecret})};
  }
  if(req.method==='POST' && path==='/auth/logout') {
    await rpc('bb_sign_out',{p_token:who.tokenHash});
    res.setHeader('Set-Cookie',cookie('',0));return {ok:true};
  }
  if(path==='/me' && req.method==='PATCH') {
    const fields={};
    for (const field of ['name','username','bio','avatar','color','notifications']) if(field in body) fields[field]=body[field];
    if('avatar' in fields && (typeof fields.avatar!=='string' || fields.avatar.length>32)) throw error('Choose a short avatar.');
    if(fields.username) fields.username=String(fields.username).toLowerCase();
    if('image' in body && body.image!==`/api/v1/photos/${who.user.id}`) {
      if(body.image===null) fields.image_key=null;
      else {
        const match=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image));
        if(!match) throw error('Choose a JPG, PNG, or WebP photo.');
        const input=Buffer.from(match[2],'base64');if(input.length>2*1024*1024) throw error('Choose a photo under 2 MB.',413);
        let buffer;
        try {buffer=await sharp(input,{limitInputPixels:16000000}).rotate().resize(512,512,{fit:'cover',withoutEnlargement:true}).webp({quality:85}).toBuffer();}
        catch {throw error('That image could not be read.');}
        const key=`${who.user.id}/${secret()}.webp`;
        const uploaded=await query(db.storage.from('player-photos').upload(key,new Blob([buffer],{type:'image/webp'})));
        fields.image_key=uploaded.key;
      }
    }
    await rpc('bb_player_action',{p_token:who.tokenHash,p_action:'profile.updated',p_body:fields});
    return {ok:true};
  }
  if(path==='/agent-keys' && req.method==='POST') {
    const token=secret();const result=await rpc('bb_player_action',{p_token:who.tokenHash,p_action:'agent.connected',p_body:{label:String(body.label || '').trim(),token_hash:hash(token)}});
    return {...result,token};
  }
  const key=/^\/agent-keys\/([^/]+)$/.exec(path);
  if(key && req.method==='DELETE') {
    if(!uuid(key[1])) throw error('Invalid connection.');
    return rpc('bb_player_action',{p_token:who.tokenHash,p_action:'agent.disconnected',p_body:{id:key[1]}});
  }
  const match=/^\/games(?:\/([^/]+)(?:\/(comments|react|subscription))?)?$/.exec(path);
  if(match) {
    const [,id,action]=match;if(id && !uuid(id)) throw error('Invalid game.');
    const operation=!id && req.method==='POST'?'game.recorded':id && !action && req.method==='PATCH'?'game.corrected':
      action==='comments' && req.method==='POST'?'comment.added':action==='comments' && req.method==='DELETE'?'comment.removed':
      action==='react' && req.method==='POST'?'reaction.updated':action==='subscription' && req.method==='PATCH'?'subscription.updated':null;
    if(!operation) throw error('Not found.',404);
    if(operation==='game.recorded' || operation==='game.corrected') Object.assign(body,seriesScore(body.matches));
    if(operation==='comment.added') {
      if(!Array.isArray(body.mentions || []) || (body.mentions || []).length>50 || (body.mentions || []).some(id=>!uuid(id))) throw error('Choose valid mentioned players.');
      body.text=String(body.text || '').trim();if(!body.text || body.text.length>500) throw error('Write a comment under 500 characters.');
      const handles=[...body.text.matchAll(/(?:^|\s)@([a-z0-9_]+)/gi)].map(m=>m[1].toLowerCase());
      const mentions=handles.length ? await readQuery(()=>db.database.from('bb_players').select('id,username').in('username',[...new Set(handles)]).limit(50)) : [];
      if((body.mentions || []).some(id=>!mentions.some(p=>p.id===id))) throw error('Mention IDs must match handles in your comment.');
      body.mentions=mentions.map(p=>p.id);
    }
    return rpc('bb_mutate',{p_token:who.tokenHash,p_action:operation,p_game:id || null,p_body:body,
      p_key:req.headers['idempotency-key'] || null,p_fingerprint:hash(JSON.stringify({operation,id,body}))});
  }
  throw error('Not found.',404);
}
const environment=await readQuery(()=>db.database.from('bb_environment').select('environment').eq('singleton',true).limit(1));
if(environment[0]?.environment!==config.environment) throw new Error('Backend environment does not match APP_ENV. Refusing to start.');
http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    checkProxy(req,config.originSecret);
    const url=new URL(req.url,'http://localhost');
    if(await serveGameShare(req,res,{origin:config.origin,key:config.otpSecret,load:loadSharedGame}))return;
    if(url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type','application/json; charset=utf-8');
      const result=await api(req,res,url);if(!res.writableEnded) res.end(JSON.stringify(result));return;
    }
    let path=url.pathname;
    if(path==='/') path='/index.html';
    if(!allowed.has(path) && path!=='/images/burnttable.jpg') throw error('Not found.',404);
    const bytes=await readFile(resolve(root,path==='/agent.md'?'skills/burntboard/SKILL.md':'.'+path)).catch(()=>{throw error('Not found.',404);});
    res.setHeader('Content-Type',mime[extname(path)] || 'application/octet-stream');res.end(bytes);
  } catch(e) {
    res.statusCode=e.status || 500;res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({error:e.status?e.message:'Something went wrong. Try again.'}));
    if(!e.status) console.error('Request failed.');
  }
}).listen(Number(process.env.PORT || 4173),process.env.HOST || '127.0.0.1',()=>console.log(`Burntboard ${config.environment}: ${config.origin}`));
let nextScheduleCheck=0;
const delivery=setInterval(()=>{
  if(!config.deliveryEnabled)return;
  if(Date.now()>=nextScheduleCheck) {
    nextScheduleCheck=Date.now()+60000;
    queueWeeklyRecap().catch(()=>console.error('Weekly recap scheduler unavailable.'));
    queueDailyMatchups().catch(()=>console.error('Daily matchup scheduler unavailable.'));
  }
  deliverOutbox().catch(()=>console.error('Email queue unavailable.'));
},15000);
delivery.unref();
