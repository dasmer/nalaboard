import {randomInt,createHmac,timingSafeEqual} from 'node:crypto';
const compare=(a,b)=>a<b?-1:a>b?1:0;
export const dailyToken=(id,key)=>id+'.'+createHmac('sha256',key).update('daily-preference-v1:'+id).digest('base64url');
export function dailyTokenPlayer(token,key) {
  if(typeof token!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/.test(token))return null;
  const id=token.split('.')[0],expected=dailyToken(id,key);
  return timingSafeEqual(Buffer.from(token),Buffer.from(expected))?id:null;
}
// Shuffle eligible pairs with cryptographic randomness. Store the winning lineup
// atomically before queueing emails, so concurrent workers/retries never reshuffle
// a lineup already issued. The optional random function makes tests reproducible.
export function dailyPairs(snapshot,random=randomInt) {
  const ids=snapshot.players.map(p=>p.id).sort(),key=(a,b)=>[a,b].sort().join(':');
  const yesterday=new Date(Date.parse(snapshot.day)-86400000).toISOString().slice(0,10);
  const blocked=new Set((snapshot.excludedPairs||[]).map(pair=>key(...pair)));
  for(const h of snapshot.history)if(h.lastPlayed===yesterday)blocked.add(key(h.player1,h.player2));
  const candidates=ids.flatMap((a,i)=>ids.slice(i+1).filter(b=>!blocked.has(key(a,b))).map(b=>[a,b]));
  for(let i=candidates.length-1;i>0;i--){const j=random(i+1);[candidates[i],candidates[j]]=[candidates[j],candidates[i]];}
  const allowed=new Set(candidates.map(pair=>key(...pair))),selected=new Map(),degree=new Map(ids.map(id=>[id,0]));
  const add=(a,b)=>{selected.set(key(a,b),[a,b].sort());degree.set(a,degree.get(a)+1);degree.set(b,degree.get(b)+1);};
  // Fill random available slots, then replace one edge with two when that gives
  // more people fresh opponents. Repeats are reserved for the fallback below.
  for(let pass=0;pass<ids.length;pass++) {
    for(const [a,b] of candidates)if(!selected.has(key(a,b))&&degree.get(a)<2&&degree.get(b)<2)add(a,b);
    const free=ids.filter(id=>degree.get(id)<2);let replacement=null;
    search:for(const [edge,[a,b]] of selected)for(const x of free)for(const y of free) {
      if([a,b].includes(x)||[a,b].includes(y)||(x===y&&degree.get(x)!==0))continue;
      if(allowed.has(key(x,a))&&allowed.has(key(y,b))&&!selected.has(key(x,a))&&!selected.has(key(y,b))){replacement={edge,a,b,x,y};break search;}
    }
    if(!replacement)break;
    const {edge,a,b,x,y}=replacement;selected.delete(edge);degree.set(a,degree.get(a)-1);degree.set(b,degree.get(b)-1);add(x,a);add(y,b);
  }
  // Give players with no fresh choices one random rematch. Pair those players
  // together first; an odd remainder can join another player without exceeding
  // two total opponents. Drop a fresh edge only when everyone else is full.
  if(ids.length<2)return [];
  const stranded=ids.filter(id=>!candidates.some(pair=>pair.includes(id)));
  for(let i=stranded.length-1;i>0;i--){const j=random(i+1);[stranded[i],stranded[j]]=[stranded[j],stranded[i]];}
  for(const a of stranded) {
    if(degree.get(a))continue;
    const choices=ids.filter(b=>b!==a&&degree.get(b)<2),unpaired=choices.filter(id=>stranded.includes(id)&&degree.get(id)===0);
    const pool=unpaired.length?unpaired:choices,b=pool.length?pool[random(pool.length)]:null;
    if(b){add(a,b);continue;}
    const partner=ids.filter(id=>id!==a)[random(ids.length-1)];
    if(!partner)continue;
    const [edge,[x,y]]=[...selected].find(([,pair])=>pair.includes(partner));
    selected.delete(edge);degree.set(x,degree.get(x)-1);degree.set(y,degree.get(y)-1);add(a,partner);
  }
  return [...selected.values()].sort((a,b)=>compare(a.join(':'),b.join(':')));
}
export function dailyEmail({snapshot,recipientId,origin,key,activeIds}) {
  const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const opponents=snapshot.pairs.filter(pair=>pair.includes(recipientId)).map(pair=>snapshot.players.find(p=>p.id===pair.find(id=>id!==recipientId))).filter(p=>p&&(!activeIds||activeIds.includes(p.id)));
  const results=snapshot.yesterdayGames||[];
  if(!opponents.length&&!results.length)return null;
  const reason=p=>{
    const h=snapshot.history.find(h=>[h.player1,h.player2].includes(recipientId)&&[h.player1,h.player2].includes(p.id));
    const yesterday=new Date(Date.parse(snapshot.day)-86400000).toISOString().slice(0,10);
    if(h?.lastPlayed===yesterday||(snapshot.excludedPairs||[]).some(pair=>pair.includes(recipientId)&&pair.includes(p.id)))return 'Run it back.';
    if(!h)return 'A fresh matchup—no games together in four weeks.';
    const days=Math.round((Date.parse(snapshot.day)-Date.parse(h.lastPlayed))/86400000);
    return days===1?'Back to the table—last played yesterday.':`Time to catch up—last played ${days} days ago.`;
  };
  const preference=origin+'/#daily-emails/'+dailyToken(recipientId,key),title=opponents.length===2?'Your two for today.':opponents.length?'Your opponent for today.':'Yesterday at the table.';
  const firstName=p=>p.name.trim().split(/\s+/)[0];
  const names=opponents.map(firstName).join(' & ');
  const subject=opponents.length?`🏓 ${names} ${opponents.length===2?'are your two':'is your matchup'} today`:'🏓 Yesterday at the table · Burntboard';
  const date=new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric',timeZone:'UTC'}).format(new Date(snapshot.day+'T00:00:00Z'));
  const avatar=p=>p.image?`<img src="${e(origin+p.image)}" width="76" height="76" alt="" style="border-radius:50%;display:block;border:4px solid #f4f2ec;object-fit:cover">`:`<table role="presentation" width="76" height="76" cellspacing="0" cellpadding="0" style="border-radius:50%;background:#edf1e7"><tr><td align="center" valign="middle" style="font-size:38px">${e(p.avatar||'🏓')}</td></tr></table>`;
  const cards=opponents.map(p=>`<tr><td style="padding:0 24px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e3e5db;border-radius:14px;background:#fffefa"><tr><td style="padding:22px 18px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td width="96" valign="top">${avatar(p)}</td><td valign="top"><h2 style="margin:0 0 8px;font-size:26px;line-height:1.15;overflow-wrap:anywhere">${e(p.name)}</h2><p style="margin:0;color:#557566;font-size:14px;line-height:1.6">${e(reason(p))}</p><table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:16px"><tr><td bgcolor="#f0532c" style="border-radius:7px"><a href="${e(origin)}/#profile/${e(p.id)}" style="display:inline-block;padding:10px 14px;border:1px solid #f0532c;border-radius:7px;font-size:13px;font-weight:bold;color:white;text-decoration:none">View player →</a></td></tr></table></td></tr></table></td></tr></table></td></tr>`).join('');
  const smallAvatar=p=>p.image?`<img src="${e(origin+p.image)}" width="26" height="26" alt="" style="border-radius:50%;vertical-align:middle;display:inline-block">`:`<span style="display:inline-block;width:26px;line-height:26px;border-radius:50%;background:#edf1e7;text-align:center;font-size:17px;vertical-align:middle">${e(p.avatar||'🏓')}</span>`;
  const rows=results.map(g=>{
    const link=origin+'/#match/'+g.id,left=g.score1>g.score2;
    const person=(p,won)=>`<a href="${e(link)}" style="text-decoration:none;color:${won?'#24251f':'#6c7367'};font-weight:${won?'bold':'normal'}">${e(p.name)}</a>`;
    return `<tr><td width="41%" style="padding:13px 0;border-top:1px solid #e3e5db;font-size:13px;overflow-wrap:anywhere">${smallAvatar(g.player1)} ${person(g.player1,left)}</td><td width="18%" align="center" style="padding:13px 4px;border-top:1px solid #e3e5db;font-size:17px;white-space:nowrap;font-weight:bold"><a href="${e(link)}" style="text-decoration:none"><span style="color:${left?'#f0532c':'#6c7367'}">${g.score1}</span><span style="color:#aaa99d;padding:0 3px">–</span><span style="color:${left?'#6c7367':'#f0532c'}">${g.score2}</span></a></td><td width="41%" align="right" style="padding:13px 0;border-top:1px solid #e3e5db;font-size:13px;overflow-wrap:anywhere">${person(g.player2,!left)} ${smallAvatar(g.player2)}</td></tr>`;
  }).join('');
  const recap=results.length?`<tr><td style="padding:8px 24px 22px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f4f2ec" style="border-radius:12px"><tr><td style="padding:20px 16px 5px">${opponents.length?'<h2 style="font-size:18px;letter-spacing:-.4px;margin:0 0 13px">Yesterday at the table</h2>':''}<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="table-layout:fixed">${rows}</table></td></tr></table></td></tr>`:'';
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f2ec;font-family:Arial,Helvetica,sans-serif;color:#24251f">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f4f2ec"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fffefa;border-radius:18px">
<tr><td bgcolor="#242a21" style="padding:23px 24px;border-radius:18px 18px 0 0;border-bottom:4px solid #f0532c"><a href="${e(origin)}/#feed" style="font-size:23px;font-weight:900;letter-spacing:-1px;color:#fffefa;text-decoration:none">BURNT<span style="color:#f0532c">BOARD.</span></a></td></tr>
<tr><td style="padding:28px 24px 24px"><p style="font-size:10px;letter-spacing:1.6px;color:#557566;font-weight:bold;text-transform:uppercase;margin:0 0 12px">${e(date)}</p><h1 style="font-size:34px;letter-spacing:-1px;line-height:1.1;margin:0">${title}</h1></td></tr>
${cards}${recap}
<tr><td align="center" style="padding:5px 24px 25px;font-size:11px"><a href="${e(preference)}" style="color:#6c7367">Manage daily matchups</a></td></tr></table></td></tr></table></body></html>`;
  return {subject,html,text:`${title} — ${date}\n\n${opponents.map(p=>`${p.name}\n${reason(p)}\n${origin}/#profile/${p.id}`).join('\n\n')}${results.length?(opponents.length?'\n\nYesterday at the table\n':'\n\n')+results.map(g=>`${g.player1.name} ${g.score1}–${g.score2} ${g.player2.name}\n${origin}/#match/${g.id}`).join('\n\n'):''}\n\nManage daily matchups: ${preference}`};
}
