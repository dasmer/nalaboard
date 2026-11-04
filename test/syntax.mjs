import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=['series.mjs','game-share.mjs','server.mjs','client.js',
  ...['server','test'].flatMap(dir=>readdirSync(dir).filter(f=>f.endsWith('.mjs')).map(f=>`${dir}/${f}`))];
for(const file of files) {
  const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
  if(result.status!==0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} app and test files.`);
