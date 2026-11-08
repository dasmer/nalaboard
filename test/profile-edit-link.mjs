import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext, runInContext} from 'node:vm';

// Exercise the real client routing and form handlers without a backend or email delivery.
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8').replace(/^import .*\n/,'');
const client=source.slice(0,source.lastIndexOf('\n$("#app").innerHTML ='));
const user={id:'player-1',name:'Test Player',username:'test_player',bio:'',avatar:'🏓',email:'player@example.test'};
function session({signedIn=false,isNew=false,hash='#edit-profile'}={}) {
  const handlers={},nodes=Object.fromEntries(['#app','#modal-root','#toast'].map(id=>[id,{
    innerHTML:'',style:{},classList:{add(){},remove(){}},
  }]));
  const requests=[],location={hash,origin:'https://nalaboard.com'};
  const context=createContext({
    console,Intl,URL,Set,Map,crypto,location,
    history:{replaceState(_state,_title,hash){location.hash=hash;}},
    document:{querySelector:selector=>nodes[selector]||null,body:{style:{}},
      addEventListener:(name,handler)=>{handlers[name]=handler;}},
    window:{addEventListener(){},scrollTo(){}},
    requestAnimationFrame:fn=>fn(),setTimeout:()=>0,clearTimeout(){},
    FormData:class {constructor(form){return Object.entries(form.values);}},
    fetch:async(path,options)=>{
      requests.push({path,options});
      if(path==='/api/v1/auth/verify') signedIn=true;
      return {ok:true,json:async()=>path.startsWith('/api/v1/state')
        ? {user:signedIn?user:null,players:[user],matches:[],activity:[],keys:[]}
        : path==='/api/v1/auth/verify'?{isNew}:path==='/api/v1/auth/request'?{email:user.email}:{}};
    },
  });
  runInContext(client,context);
  const refresh=()=>runInContext('refresh()',context);
  const submit=async(form,values={})=>{
    const error={textContent:''};
    await handlers.submit({preventDefault(){},target:{dataset:{form,email:user.email},values,
      querySelector:selector=>selector==='.form-error'?error:null}});
    assert.equal(error.textContent,'');
  };
  return {nodes,location,requests,refresh,submit,run:code=>runInContext(code,context)};
}
const direct=session({signedIn:true});
assert.equal(await direct.refresh(),true);
assert.equal(direct.location.hash,'#profile/player-1');
assert.match(direct.nodes['#modal-root'].innerHTML,/Upload your photo/);
assert.match(direct.nodes['#modal-root'].innerHTML,/Save player card/);
assert.equal(direct.requests.length,1); // Opening the link never mutates the profile.
direct.run('closeModal()');
await direct.refresh();
assert.equal(direct.nodes['#modal-root'].innerHTML,''); // The consumed link does not reopen.

for(const isNew of [false,true]) {
  const login=session({isNew});
  assert.equal(await login.refresh(),false);
  assert.match(login.nodes['#modal-root'].innerHTML,/Work email/);
  assert.equal(login.location.hash,'#edit-profile');
  await login.submit('email',{email:user.email});
  assert.match(login.nodes['#modal-root'].innerHTML,/Six-digit code/);
  await login.submit('otp',{code:'123456'});
  assert.equal(login.location.hash,'#profile/player-1');
  assert.match(login.nodes['#modal-root'].innerHTML,/Upload your photo/);
  assert.match(login.nodes['#modal-root'].innerHTML,/Save player card/);
  await login.submit('profile',{name:user.name,username:user.username,bio:''});
  assert.equal(login.nodes['#modal-root'].innerHTML,'');
  assert.ok(login.requests.some(r=>r.path==='/api/v1/me' && r.options.method==='PATCH'));
}
for(const isNew of [false,true]) {
  const normal=session({hash:'#feed',isNew});
  await normal.refresh();
  assert.equal(normal.nodes['#modal-root'].innerHTML,'');
  await normal.submit('otp',{code:'123456'});
  assert.equal(normal.location.hash,'#feed');
  assert.equal(normal.nodes['#modal-root'].innerHTML.includes('Join the roster'),isNew);
}
console.log('Profile edit links: signed-in, returning/new sign-in, save, close, and normal onboarding passed.');
