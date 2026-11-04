import {createHmac,timingSafeEqual} from 'node:crypto';
import {escapeEmail as e} from './email-templates.mjs';
const compare=(a,b)=>a<b?-1:a>b?1:0;
export function weeklyToken(id,key) {return id+'.'+createHmac('sha256',key).update('weekly-preference-v1:'+id).digest('base64url');}
export function weeklyTokenPlayer(token,key) {
  if(typeof token!=='string' || !/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token))return null;
  const id=token.split('.')[0],expected=weeklyToken(id,key);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)&&timingSafeEqual(Buffer.from(token),Buffer.from(expected))?id:null;
}
export function weeklyLeaders(snapshot) {
  const records=new Map();
  for(const g of snapshot.games)for(const id of[g.player1,g.player2]) {
    const r=records.get(id)||{id,wins:0,losses:0},winner=g.score1>g.score2?g.player1:g.player2;
    r.wins+=+(id===winner);r.losses+=+(id!==winner);records.set(id,r);
  }
  const sorted=[...records.values()].sort((a,b)=>b.wins-a.wins||a.losses-b.losses||compare(a.id,b.id));
  return sorted.filter(r=>r.wins===sorted[0].wins&&r.losses===sorted[0].losses);
}
export function weeklyEmail({snapshot,recipientId,origin,key}) {
  const people=new Map(snapshot.players.map(p=>[p.id,p])),leaders=weeklyLeaders(snapshot),person=id=>people.get(id);
  if(!leaders.length)throw Error('Empty weekly recap');
  const name=p=>p.name.charAt(0).toUpperCase()+p.name.slice(1),names=leaders.map(l=>name(person(l.id)));
  const subject=leaders.length===1?`👑 ${names[0]} takes the week · Burntboard`:`👑 ${names.join(' & ')} share the crown · Burntboard`;
  const preference=origin+'/#weekly-emails/'+weeklyToken(recipientId,key);
  const dateLabel=date=>new Date(date+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
  const period=dateLabel(snapshot.weekStart)+' – '+dateLabel(snapshot.weekEnd);
  function avatar(p,size) {
    if(p.image)return `<img src="${e(origin+p.image)}" width="${size}" height="${size}" alt="${e(name(p))}" style="display:block;border-radius:50%;border:3px solid #dce5d6">`;
    const color=/^#[a-f0-9]{6}$/i.test(p.color)?p.color:'#739783';
    return `<table role="presentation" width="${size}" height="${size}" cellspacing="0" cellpadding="0"><tr><td align="center" bgcolor="${color}" style="border-radius:50%;font-size:${Math.round(size*.6)}px">${e(p.avatar||p.name[0])}</td></tr></table>`;
  }
  const blocks=leaders.map(l=>{
    const p=person(l.id),games=snapshot.games.filter(g=>[g.player1,g.player2].includes(l.id)).sort((a,b)=>compare(a.date,b.date)||compare(a.id,b.id));
    const rows=games.map(g=>{const first=g.player1===l.id,opponent=person(first?g.player2:g.player1),a=first?g.score1:g.score2,b=first?g.score2:g.score1;
      return `<tr><td style="padding:14px 0;border-top:1px solid #e3e5db"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="padding-right:10px">${avatar(opponent,34)}</td><td style="font-size:14px;font-weight:bold">${e(name(opponent))}</td></tr></table></td><td align="center" style="padding:14px 5px;border-top:1px solid #e3e5db;font-size:12px;color:${a>b?'#557566':'#a3482a'}">${a>b?'Won':'Lost'}</td><td align="right" style="padding:14px 0;border-top:1px solid #e3e5db;font-size:18px;font-weight:900">${a}–${b}</td></tr>`;}).join('');
    return `<tr><td align="center" bgcolor="#edf1e7" style="padding:22px 24px 28px"><table role="presentation" cellspacing="0" cellpadding="0" align="center"><tr><td align="center" style="font-size:39px;line-height:43px">👑</td></tr><tr><td>${avatar(p,116)}</td></tr></table><h2 style="font-size:34px;line-height:1.1;margin:17px 0 10px">${e(name(p))} ${leaders.length===1?'takes the week.':'shares the crown.'}</h2><p style="font-size:14px;color:#557566;margin:0">${leaders.length===1?'The crown belongs to '+e(name(p))+' this week.':'One of this week’s joint winners.'}</p><p style="font-size:18px;font-weight:bold;margin:17px 0 0">${l.wins} ${l.wins===1?'win':'wins'} · ${l.losses} ${l.losses===1?'loss':'losses'}</p></td></tr><tr><td bgcolor="#fffefa" style="padding:24px 28px"><h3 style="font-size:20px;margin:0 0 17px">${e(name(p))}’s week at the table</h3><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><th align="left" style="font-size:9px;letter-spacing:1px;padding-bottom:10px">OPPONENT</th><th style="font-size:9px;letter-spacing:1px;padding-bottom:10px">RESULT</th><th align="right" style="font-size:9px;letter-spacing:1px;padding-bottom:10px">MATCH WINS</th></tr>${rows}</table></td></tr>`;
  }).join('');
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f2ec;font-family:Arial,Helvetica,sans-serif;color:#24251f"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f4f2ec"><tr><td align="center" style="padding:25px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px"><tr><td bgcolor="#242a21" style="padding:25px 28px;border-radius:16px 16px 0 0"><a href="${e(origin)}/#feed" style="font-size:26px;font-weight:900;color:#fffefa;text-decoration:none">BURNT<span style="color:#f0532c">BOARD.</span></a></td></tr><tr><td bgcolor="#fffefa" style="padding:29px 28px 25px;border-top:4px solid #f0532c"><p style="font-size:10px;letter-spacing:2px;color:#557566;font-weight:bold;margin:0 0 13px">${e(period)} · THE WEEKLY RECAP</p><h1 style="font-size:32px;line-height:1.1;margin:0">This week at the table.</h1></td></tr>${blocks}<tr><td bgcolor="#fffefa" style="padding:7px 28px 30px;border-radius:0 0 16px 16px"><table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#f0532c" style="border-radius:9px"><a href="${e(origin)}/#feed" style="display:inline-block;padding:15px 24px;border:1px solid #f0532c;border-radius:9px;font-size:14px;font-weight:bold;color:white;text-decoration:none">See the board →</a></td></tr></table></td></tr><tr><td align="center" style="padding:20px 15px;font-size:11px;line-height:1.7;color:#6c7367">Sunday through Friday, 7:30 PM Pacific.<br><a href="${e(preference)}" style="color:#557566">Manage weekly recap emails</a><br>Open the page, then tap Unsubscribe to stop these emails.</td></tr></table></td></tr></table></body></html>`;
  const text=`This week at the table — ${period}\n\n${leaders.map(l=>`${name(person(l.id))}: ${l.wins} wins, ${l.losses} losses\n`+snapshot.games.filter(g=>[g.player1,g.player2].includes(l.id)).sort((a,b)=>compare(a.date,b.date)||compare(a.id,b.id)).map(g=>{const first=g.player1===l.id,a=first?g.score1:g.score2,b=first?g.score2:g.score1;return `${name(person(first?g.player2:g.player1))}: ${a>b?'Won':'Lost'} ${a}–${b}`;}).join('\n')).join('\n\n')}\n\nSee the board: ${origin}/#feed\nManage weekly recap emails: ${preference}\nOpen the page, then tap Unsubscribe to stop these emails.`;
  return {subject,html,text};
}
