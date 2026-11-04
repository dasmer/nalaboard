import { readFileSync } from 'node:fs';
import { createAdminClient } from '@insforge/sdk';

let linked = {};
try { linked = JSON.parse(readFileSync(new URL('../.insforge/project.json', import.meta.url))); } catch {}
export const config = {
  origin: process.env.APP_ORIGIN || 'http://localhost:4173',
  url: process.env.INSFORGE_URL || linked.oss_host,
  apiKey: process.env.INSFORGE_API_KEY || linked.api_key,
  resendKey: process.env.RESEND_API_KEY,
  otpSecret: process.env.OTP_SECRET,
  from: 'Burntboard <info@burntboard.com>',
  testRecipients: (process.env.EMAIL_TEST_RECIPIENTS || '').split(',').filter(Boolean),
  testSink: process.env.EMAIL_TEST_SINK,
  deliveryEnabled: process.env.APP_ENV === 'production' || process.env.EMAIL_DELIVERY_ENABLED !== 'false',
  environment: process.env.APP_ENV || 'test',
  trustProxy: process.env.TRUST_PROXY === 'true',
  originSecret: process.env.ORIGIN_SECRET,
};
if (!config.url || !config.apiKey) throw new Error('Link an InsForge project or configure server credentials.');
if (!['test','production'].includes(config.environment)) throw new Error('APP_ENV must be test or production.');
if (config.environment === 'production' && !config.origin.startsWith('https://')) throw new Error('Production requires an HTTPS APP_ORIGIN.');
if (config.environment === 'production' && (config.testSink || config.testRecipients.length)) throw new Error('Test email routing is forbidden in production.');
if (config.environment === 'production' && (!config.resendKey || !config.otpSecret || config.otpSecret.length<32)) throw new Error('Production requires Resend and a strong OTP_SECRET.');
if (config.trustProxy && (!config.originSecret || config.originSecret.length<32)) throw new Error('Trusted proxy headers require a strong ORIGIN_SECRET.');
export const db = createAdminClient({baseUrl: config.url, apiKey: config.apiKey});
export async function query(promise) {
  const {data,error} = await promise;
  if (error) {
    const message = error.message || 'Database request failed.';
    if (/duplicate key|unique constraint/i.test(message)) throw Object.assign(new Error('That username or request is already in use.'),{status:409});
    if (/violates check constraint|invalid input syntax|not-null constraint|foreign key constraint/i.test(message)) throw Object.assign(new Error('Check the players, score, date, and profile fields.'),{status:400});
    throw Object.assign(new Error(message),{code:error.code,backendStatus:error.statusCode});
  }
  return data;
}
// Only use for side-effect-free reads. Mutations retain their own idempotency.
export async function readQuery(run) {
  for(let attempt=0;;attempt++) {
    try {return await query(run());}
    catch(e) {
      if(attempt>=2 || !(/socket hang up|fetch failed|ECONNRESET|502 Bad Gateway|503 Service Unavailable|504 Gateway/i.test(e.message) || [502,503,504].includes(e.backendStatus))) throw e;
      await new Promise(resolve=>setTimeout(resolve,150*2**attempt));
    }
  }
}
export async function rpc(name, args) {
  const result = await query(db.database.rpc(name, args));
  if (result?.error) {
    const e = new Error(result.error); e.status = result.status || 400; throw e;
  }
  return result;
}
