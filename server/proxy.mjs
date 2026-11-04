import {createHash,timingSafeEqual} from 'node:crypto';
const digest=value=>createHash('sha256').update(String(value || '')).digest();
export function checkProxy(req,secret) {
  if(secret && !timingSafeEqual(digest(req.headers['x-origin-secret']),digest(secret))) {
    throw Object.assign(new Error('Request must use the public site.'),{status:403});
  }
}
export function clientIp(req,trustProxy) {
  // Vercel replaces this header with the visitor's IP; Fly may append its edge hop.
  return (trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}
