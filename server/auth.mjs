import {createHash,createHmac,randomBytes,randomInt} from 'node:crypto';
import {config,db,query,readQuery,rpc} from './config.mjs';
import {sendOtp} from './email.mjs';
export const hash=(s)=>createHash('sha256').update(s).digest('hex');
export const secret=()=>randomBytes(32).toString('base64url');
export const error=(message,status=400)=>Object.assign(new Error(message),{status});
const otpHash=(email,code)=>{
  if (!config.otpSecret) throw error('OTP_SECRET is not configured.',503);
  return createHmac('sha256',config.otpSecret).update(email+':'+code).digest('hex');
};
export const emailAddress=(input)=>{
  const email=String(input || '').trim().toLowerCase();
  if (email.length>254 || !/^[^@\s]+@(useallowance\.com|getburnt\.ai)$/.test(email)) throw error('Use your Burnt or Allowance email.');
  return email;
};
export function cookie(token,maxAge=30*86400) {
  return `bb_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.origin.startsWith('https:')?'; Secure':''}`;
}
export async function requestCode(body,ip) {
  const email=emailAddress(body.email), code=String(randomInt(1000000)).padStart(6,'0');
  const digest=otpHash(email,code);
  await rpc('bb_request_otp',{p_email:email,p_hash:digest,p_ip:hash(ip)});
  try { await sendOtp(email,code,`otp-${digest}`); }
  catch {
    await query(db.database.from('bb_otp').delete().eq('email',email).eq('code_hash',digest));
    throw error('The sign-in email could not be sent. Please try again.',503);
  }
  return {email};
}
export async function verifyCode(body,res) {
  const email=emailAddress(body.email), code=String(body.code || '');
  if (!/^\d{6}$/.test(code)) throw error('Enter the six-digit code.',401);
  const token=secret(), kind=body.kind==='agent'?'agent':'web';
  const out=await rpc('bb_verify_otp',{p_email:email,p_hash:otpHash(email,code),p_token_hash:hash(token),p_kind:kind});
  if (kind==='web') res.setHeader('Set-Cookie',cookie(token));
  return {...out,...(kind==='agent'?{token}:{})};
}
export async function identity(req) {
  const bearer=/^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  const browserToken=/(?:^|;\s*)bb_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const token=bearer || browserToken;
  if (!token) return null;
  const sessions=await readQuery(()=>db.database.from('bb_sessions').select('id,player_id,kind,label,expires_at,revoked_at').eq('token_hash',hash(token)).limit(1));
  const session=sessions[0];
  if (!session || session.revoked_at || Date.parse(session.expires_at)<=Date.now() || (bearer && session.kind!=='agent')) return null;
  const people=await readQuery(()=>db.database.from('bb_players').select('id,email,name,username,bio,avatar,color,image_key,notifications,weekly_recap,daily_matchups').eq('id',session.player_id).limit(1));
  return people[0]?{user:people[0],session,tokenHash:hash(token)}:null;
}
