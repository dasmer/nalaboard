import assert from 'node:assert/strict';
import {otpEmail,activityEmail} from '../server/email-templates.mjs';
const origin='https://burntboard.com', gameId='example-game';
const base={origin,recipientId:'example-player',actorName:'Alex <script>alert(1)</script>',player1Name:'Alex & Sam',player2Name:'Jordan'};
const after={score1:2,score2:1,matches:[{score1:11,score2:7},{type:'unrecorded',winner:2},{type:'deuce',winner:1}]};
const otp=otpEmail({origin,code:'012345'});
assert.ok(otp.html.includes('012345') && otp.text.includes('012345'));
assert.ok(otp.html.includes('10 minutes') && otp.text.includes('10 minutes'));
for(const payload of [
  {action:'comment.added',gameId,text:'<img src=x onerror=alert(1)>\n@jordan Great game!'},
  {action:'game.recorded',gameId,after},
  {action:'game.corrected',gameId,after,before:{score1:2,score2:0,matches:[{score1:11,score2:7},{score1:11,score2:9}]}},
  {action:'agent.connected',label:'Codex <script>alert(1)</script>'},
]) {
  const {html,text}=activityEmail({...base,payload});
  assert.ok(!html.includes('<script>') && !html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
  if(payload.action==='agent.connected') {
    assert.ok(html.includes('href="https://burntboard.com/#agents"'));
    assert.ok(text.includes('Manage agent connection:') && !text.includes('View game:'));
    assert.ok(html.includes('If you didn’t create this connection'));
  } else {
    assert.ok(html.includes('href="https://burntboard.com/#match/example-game"'));
    assert.ok(html.includes('href="https://burntboard.com/#profile/example-player"'));
  }
  if(payload.action==='comment.added') assert.ok(html.includes('<br>@jordan Great game!'));
  if(payload.after) assert.ok(html.includes('Alex &amp; Sam') && text.includes('won in deuce'));
  if(payload.before) assert.ok(html.includes('Previously: 2–0 (11–7, 11–9)') && text.includes('from 2–0'));
}
console.log('Email template checks passed: leading-zero code, escaping, multiline comments, series scores, corrections, and security links.');

const mixedMail=activityEmail({origin,payload:{action:'game.recorded',gameId:'fixture',after},actorName:'Alex',player1Name:'Alex',player2Name:'Jordan'});
assert.ok(mixedMail.html.includes('Score not recorded') && mixedMail.text.includes('Jordan won'));
assert.ok(!mixedMail.html.includes('undefined') && !mixedMail.text.includes('NaN'));
