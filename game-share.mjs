import {matchLabel} from './series.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';
import sharp from 'sharp';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const signature=(id,key)=>createHmac('sha256',key).update(`burntboard:game-share:v1:real:${id}`).digest('hex');
export function gameShareURL({origin,id,key}) {
  if(!key)throw new Error('Game sharing requires a configured signing secret.');
  return `${origin}/g/${id}/${signature(id,key)}`;
}
// Deliberate allowlist: no notes, comments, identities, photos, or history.
export function publicReceipt(game,players) {
  return {names:[game.player1,game.player2].map(id=>players.find(p=>p.id===id)?.name||'Player'),
    score1:game.score1,score2:game.score2,matches:game.matches.map(m=>m.type==='deuce'||m.type==='unrecorded'?{type:m.type,winner:m.winner}:{score1:m.score1,score2:m.score2}),date:game.date,revision:game.revision};
}
const description=r=>`${r.names[0]} ${r.score1}–${r.score2} ${r.names[1]} · ${r.matches.map(m=>matchLabel(m,r.names)).join(' / ')} · Best of three`;
const dateLabel=date=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));
const initials=name=>Array.from(name.trim().split(/\s+/).map(w=>Array.from(w)[0]).slice(0,2).join('')).join('').toUpperCase();
const shortName=name=>Array.from(name).length>23?Array.from(name).slice(0,22).join('')+'…':name;
export async function gameCard(r) {
  const winner=r.score1>r.score2?0:1;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#f4f2ec"/><rect x="32" y="32" width="1136" height="566" rx="28" fill="#fffefa" stroke="#e4e3db"/>
<path d="M60 32H1140Q1168 32 1168 60V124H32V60Q32 32 60 32" fill="#24251f"/><rect x="32" y="124" width="1136" height="5" fill="#f0532c"/>
<g font-family="DejaVu Sans,Arial,sans-serif"><text x="68" y="94" font-size="38" font-weight="bold" fill="#fffefa">BURNT<tspan fill="#f0532c">BOARD.</tspan></text><text x="1128" y="88" text-anchor="end" font-size="17" letter-spacing="2" fill="#c0c5b8">SETTLE IT AT THE TABLE</text>
<text x="600" y="176" text-anchor="middle" font-size="16" letter-spacing="3" fill="#767970">${esc(dateLabel(r.date).toUpperCase())} · BEST OF THREE · FINAL</text>
${r.names.map((name,i)=>{const x=i?926:274;return `<circle cx="${x}" cy="272" r="55" fill="${i===winner?'#557566':'#e9e8e0'}"/><text x="${x}" y="286" text-anchor="middle" font-size="34" font-weight="bold" fill="${i===winner?'#fffefa':'#557566'}">${esc(initials(name))}</text><text x="${x}" y="366" text-anchor="middle" font-size="${Math.min(29,Math.floor(380/(Array.from(shortName(name)).length*1.1)))}" font-weight="bold" fill="#24251f">${esc(shortName(name))}</text><text x="${x}" y="403" text-anchor="middle" font-size="14" letter-spacing="3" fill="${i===winner?'#f0532c':'#767970'}">${i===winner?'WINNER':'GOOD GAME'}</text>`}).join('')}
<text x="600" y="340" text-anchor="middle" font-size="116" font-weight="bold" fill="#24251f">${r.score1}<tspan fill="#b3b8a8"> : </tspan>${r.score2}</text>
${r.matches.map((m,i)=>{const width=200,gap=14,start=600-(r.matches.length*width+(r.matches.length-1)*gap)/2,x=start+i*(width+gap);return `<rect x="${x}" y="441" width="200" height="64" rx="12" fill="#edf1eb"/><text x="${x+100}" y="466" text-anchor="middle" font-size="12" letter-spacing="2" fill="#557566">MATCH ${i+1}</text><text x="${x+100}" y="491" text-anchor="middle" font-size="${m.type?11:21}" font-weight="bold" fill="#24251f">${esc(matchLabel(m,r.names.map(n=>Array.from(n.split(" ")[0]).slice(0,10).join(""))))}</text>`}).join('')}
<text x="68" y="558" font-size="16" font-weight="bold" fill="#557566">GOOD GAMES. GREAT COMPANY.</text><text x="1128" y="558" text-anchor="end" font-size="16" fill="#767970">BURNTBOARD.COM</text></g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
export function receiptPage({receipt:r,url,id,origin}) {
  const title=`${r.names[0]} vs ${r.names[1]} · ${r.score1}–${r.score2}`,desc=description(r),image=`${url}/image.png?v=${r.revision}`;
  return `<!doctype html><html lang="en" prefix="og: https://ogp.me/ns#"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · Burntboard</title>
<meta name="description" content="${esc(desc)}"><link rel="canonical" href="${esc(url)}"><meta property="og:type" content="website"><meta property="og:site_name" content="Burntboard"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:image" content="${esc(image)}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${esc(desc)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(image)}"><meta name="twitter:image:alt" content="${esc(desc)}">
<link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/client.css"><style>.shared-receipt{max-width:960px;margin:0 auto;padding:28px 20px 60px}.shared-brand{display:block;margin-bottom:28px;font-size:22px;font-weight:800}.shared-image{display:block;width:100%;height:auto;border-radius:20px}.shared-content{max-width:600px;margin:26px auto;text-align:center}.shared-content h1{font-size:38px}.shared-result{font-size:64px;margin:18px 0}.shared-matches{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin:18px 0}.shared-matches span{background:#edf1eb;padding:12px 18px;border-radius:10px}.shared-names{overflow-wrap:anywhere}.shared-content .btn{margin-top:16px}</style></head>
<body><main class="shared-receipt"><a class="shared-brand" href="/">BURNT<span class="orange">BOARD.</span></a><img class="shared-image" src="${esc(image)}" alt="${esc(desc)}" width="1200" height="630"><section class="shared-content"><div class="eyebrow orange">THE GAME RECEIPT</div><h1 class="shared-names">${esc(r.names[0])} vs ${esc(r.names[1])}</h1><p class="muted">${esc(dateLabel(r.date))} · Best of three · Play to 11, win by two</p><div class="display shared-result">${r.score1} : ${r.score2}</div><p><strong>${esc(r.names[r.score1>r.score2?0:1])}</strong> took the W.</p><div class="shared-matches">${r.matches.map((m,i)=>`<span>Match ${i+1}<br><strong>${esc(matchLabel(m,r.names))}</strong></span>`).join('')}</div><a class="btn primary" href="${esc(origin)}/#match/${esc(id)}">Open in the clubhouse →</a><p class="tooltip-note">The conversation and player profiles stay in the clubhouse.</p></section></main></body></html>`;
}
export async function serveGameShare(req,res,{origin,key,load}) {
  const path=new URL(req.url,'http://localhost').pathname;
  if(!path.startsWith('/g/'))return false;
  const match=new RegExp(`^/g/([a-zA-Z0-9-]{1,64})/([a-f0-9]{64})(/image\\.png)?$`).exec(path);
  if(!['GET','HEAD'].includes(req.method)||!match||!key||!timingSafeEqual(Buffer.from(match[2],'hex'),Buffer.from(signature(match[1],key),'hex'))) {
    res.statusCode=404;res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('Game receipt not found.');return true;
  }
  const found=await load(match[1]);
  if(!found){res.statusCode=404;res.end('Game receipt not found.');return true;}
  const receipt=publicReceipt(found.game,found.players),url=gameShareURL({origin,id:match[1],key});
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Type',match[3]?'image/png':'text/html; charset=utf-8');
  const body=match[3]?await gameCard(receipt):receiptPage({receipt,url,id:match[1],origin});res.end(req.method==='HEAD'?undefined:body);return true;
}
