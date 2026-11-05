import assert from 'node:assert/strict';
Object.assign(process.env,{APP_ENV:'test',INSFORGE_URL:'http://localhost:1',INSFORGE_API_KEY:'fixture-only'});
const {emailAddress}=await import('../server/auth.mjs');
for(const email of ['person@nala.money','person@rafiki.com','person@useallowance.com'])assert.equal(emailAddress(email),email);
assert.equal(emailAddress('  PERSON@NALA.MONEY  '),'person@nala.money');
assert.equal(emailAddress('  PERSON@RAFIKI.COM  '),'person@rafiki.com');
for(const email of ['person@nala.com','person@getburnt.ai','person@sub.rafiki.com','person@rafiki.com.evil.test','person@rafikicom','person@@rafiki.com','person @rafiki.com','person@sub.nala.money','person@nala.money.evil.test','person@@nala.money','person @nala.money','person@nala.money\n.evil.test',''])assert.throws(()=>emailAddress(email),e=>e.status===400);
console.log('Nalaboard domain checks passed: exact allowlist, normalisation, and alias/lookalike rejection.');
