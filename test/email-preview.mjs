// Local-only fixtures. No backend credentials, network delivery, or production route.
import http from 'node:http';
import {otpEmail,activityEmail} from '../server/email-templates.mjs';
const base={origin:'https://burntboard.com',recipientId:'preview',actorName:'Alex',player1Name:'Alex',player2Name:'Jordan'};
const after={score1:2,score2:1,matches:[{score1:11,score2:7},{score1:9,score2:11},{score1:14,score2:12}]};
const previews={
  login:otpEmail({origin:base.origin,code:'012345'}),
  comment:activityEmail({...base,payload:{action:'comment.added',gameId:'preview',text:'@jordan That deuce finish was unreal.\nRematch tomorrow? 🏓'}}),
  game:activityEmail({...base,payload:{action:'game.recorded',gameId:'preview',after}}),
  correction:activityEmail({...base,payload:{action:'game.corrected',gameId:'preview',after,before:{score1:2,score2:0,matches:[{score1:11,score2:7},{score1:11,score2:9}]}}}),
  agent:activityEmail({...base,payload:{action:'agent.connected',label:'My Codex'}}),
};
http.createServer((req,res)=>{
  const key=new URL(req.url,'http://localhost').pathname.slice(1);
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if(previews[key]) return res.end(previews[key].html);
  if(key) {res.statusCode=404;return res.end('Preview not found.');}
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Burntboard email previews</title><style>body{margin:0;background:#e7e8e1;font-family:Arial,sans-serif;color:#24251f}header{padding:24px 28px;background:#24251f;color:#fffefa}h1{margin:0;font-size:24px}p{font-size:13px;color:#b9bdaf}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,570px),1fr));gap:24px;padding:24px}article{min-width:0}h2{font-size:14px;text-transform:uppercase;letter-spacing:2px}a{color:inherit}iframe{width:100%;height:660px;border:0;border-radius:16px}</style><header><h1>BURNT<span style="color:#f0532c">BOARD.</span> / EMAILS</h1><p>Local design previews · fictional content · nothing is sent</p></header><main>${Object.keys(previews).map(k=>`<article><h2><a href="/${k}">${k}</a></h2><iframe title="${k} email preview" src="/${k}"></iframe></article>`).join('')}</main></html>`);
}).listen(4180,'127.0.0.1',()=>console.log('Email previews: http://localhost:4180'));
