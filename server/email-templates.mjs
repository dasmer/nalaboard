import {matchLabel} from '../series.mjs';
// Inline styles and presentation tables keep the essentials intact in email clients.
export const escapeEmail = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const heading = 'font-family:Arial,Helvetica,sans-serif;font-weight:900;letter-spacing:-1px;';
const paragraph = 'margin:0 0 20px;font-size:16px;line-height:1.65;color:#55594f;';

function frame({origin,preheader,kicker,title,content,button,href,footer}) {
  const e=escapeEmail;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f2ec;color:#24251f;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${e(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f2ec"><tr><td align="center" style="padding:32px 12px;">
<!--[if mso]><table role="presentation" width="560" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;border-collapse:separate;">
<tr><td bgcolor="#24251f" style="padding:25px 28px;border-radius:16px 16px 0 0;">
<a href="${e(origin)}" style="${heading}font-size:24px;color:#fffefa;text-decoration:none;">BURNT<span style="color:#f0532c;">BOARD</span><span style="color:#f0532c;">.</span></a>
<p style="margin:8px 0 0;color:#b9bdaf;font-size:11px;letter-spacing:2px;text-transform:uppercase;">Settle it at the table.</p></td></tr>
<tr><td bgcolor="#fffefa" style="padding:34px 28px 30px;border:1px solid #e4e3db;border-top:4px solid #f0532c;border-radius:0 0 16px 16px;">
<p style="margin:0 0 13px;font-size:11px;font-weight:bold;letter-spacing:2px;color:#557566;text-transform:uppercase;">${e(kicker)}</p>
<h1 style="${heading}margin:0 0 22px;font-size:36px;line-height:1.1;color:#24251f;">${e(title)}</h1>
${content}
${button ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#f0532c" style="border-radius:8px;mso-padding-alt:15px 24px;"><a href="${e(href)}" style="display:inline-block;padding:15px 24px;color:#ffffff;font-size:14px;font-weight:bold;text-decoration:none;border:1px solid #f0532c;border-radius:8px;">${e(button)} &rarr;</a></td></tr></table>` : ''}
</td></tr>
<tr><td align="center" style="padding:22px 20px 0;color:#767970;font-size:12px;line-height:1.7;">${footer}<p style="margin:14px 0 0;font-weight:bold;letter-spacing:1px;color:#557566;">GOOD GAMES. GREAT COMPANY.</p></td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

export function otpEmail({origin,code}) {
  return {
    text:`Your Burntboard sign-in code is ${code}. It expires in 10 minutes and can be used once. If you did not request this, ignore this email.`,
    html:frame({origin,preheader:'Your one-time sign-in code. Ready when you are.',kicker:'YOUR SEAT AT THE TABLE',title:'One serve away.',
      content:`<p style="${paragraph}">Enter this code in Burntboard to sign in. Then get back to the good stuff.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="#edf1eb" style="padding:23px 12px;border:1px solid #d9e1d5;border-radius:10px;">
<p style="margin:0 0 10px;font-size:10px;font-weight:bold;letter-spacing:2px;color:#557566;">YOUR SIGN-IN CODE</p>
<p style="margin:0;font-family:Consolas,Menlo,monospace;font-size:36px;font-weight:bold;letter-spacing:6px;color:#24251f;">${escapeEmail(code)}</p></td></tr></table>
<p style="margin:17px 0 0;font-size:13px;color:#767970;line-height:1.6;">One use. Expires in 10 minutes. Keep this code to yourself.</p>`,
      footer:'Didn’t request a code? You can safely ignore this email.'}),
  };
}

export function activityEmail({origin,payload,actorName,recipientId,player1Name='Player 1',player2Name='Player 2'}) {
  const e=escapeEmail, agent=payload.action==='agent.connected', comment=payload.action==='comment.added';
  const link=agent?`${origin}/#agents`:`${origin}/#match/${payload.gameId}`;
  const score=payload.after,before=payload.before;
  const scores=s=>`${s.score1}–${s.score2} (${s.matches.map(m=>matchLabel(m,[player1Name,player2Name])).join(', ')})`;
  const message=agent?`A new agent connection, ${payload.label}, was created for your account. Disconnect it on the Agents page if you did not create it.`:
    comment?`${actorName} commented: ${payload.text}`:
    `${actorName} ${before?`corrected the score from ${scores(before)} to`:'recorded a best-of-three game:'} ${scores(score)}.`;
  let content;
  if(agent) content=`<p style="${paragraph}">Your agent is ready to take the court with you.</p><p style="padding:18px;background-color:#edf1eb;border-left:4px solid #557566;border-radius:8px;font-size:16px;font-weight:bold;">${e(payload.label)}</p><p style="${paragraph}">If you didn’t create this connection, disconnect it on the Agents page.</p>`;
  else if(comment) content=`<p style="${paragraph}"><strong style="color:#24251f;">${e(actorName)}</strong> commented on a game you follow.</p><div style="padding:20px;margin:0 0 24px;background-color:#edf1eb;border-left:4px solid #557566;border-radius:8px;color:#24251f;font-size:17px;line-height:1.65;overflow-wrap:anywhere;word-break:break-word;">${e(payload.text).replace(/\r?\n/g,'<br>')}</div>`;
  else content=`<p style="${paragraph}"><strong style="color:#24251f;">${e(actorName)}</strong> ${before?'corrected the score. Here’s the updated result.':'put a new game on the board.'}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#edf1eb" style="margin:0 0 24px;border:1px solid #d9e1d5;border-radius:10px;table-layout:fixed;">
<tr><td width="38%" align="center" style="padding:22px 8px 8px;color:#557566;font-size:12px;font-weight:bold;word-break:break-word;">${e(player1Name)}</td><td width="24%" align="center" style="padding:22px 0 8px;font-size:10px;font-weight:bold;color:#767970;">BEST OF THREE</td><td width="38%" align="center" style="padding:22px 8px 8px;color:#557566;font-size:12px;font-weight:bold;word-break:break-word;">${e(player2Name)}</td></tr>
<tr><td align="center" style="${heading}padding:0 8px 12px;font-size:48px;">${e(score.score1)}</td><td align="center" style="font-size:24px;color:#767970;">–</td><td align="center" style="${heading}padding:0 8px 12px;font-size:48px;">${e(score.score2)}</td></tr>
<tr><td colspan="3" align="center" style="padding:0 12px 22px;font-size:13px;line-height:1.7;color:#55594f;">${score.matches.map((m,i)=>`Match ${i+1}: <strong>${e(matchLabel(m,[player1Name,player2Name]))}</strong>`).join(' &nbsp;·&nbsp; ')}${before?`<br><span style="color:#767970;">Previously: ${e(scores(before))}</span>`:''}</td></tr></table>`;
  return {
    text:`${message}\n\n${agent?'Manage agent connection':'View game'}: ${link}\n${agent?'':'Manage email preferences in your Burntboard profile.'}`.trim(),
    html:frame({origin,preheader:message,kicker:agent?'YOUR AGENT CONNECTION':comment?'FROM THE SIDELINES':'ON THE BOARD',
      title:agent?'You’ve got backup.':comment?'Table talk.':before?'Score settled.':'Good game.',content,
      button:agent?'Manage connection':comment?'Join the conversation':'View game',href:link,
      footer:agent?'This is a security notice about your Burntboard account.':`You’re receiving updates for this game.<br>Manage email preferences from your <a href="${e(origin)}/#profile/${e(recipientId)}" style="color:#557566;text-decoration:underline;">Burntboard profile</a>.`}),
  };
}
