// Isolated DOM tests, not a claim of Safari/device or visual browser validation.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const pkg = fs.readdirSync('/app/node_modules/.pnpm').find(x=>x.startsWith('jsdom@'));
const {JSDOM} = await import('/app/node_modules/.pnpm/'+pkg+'/node_modules/jsdom/lib/api.js');
const base = '/app/ui-fixture';
const html = fs.readFileSync(base+'/index.html','utf8');
const js = fs.readFileSync(base+'/app.js','utf8');
const state = {version:'0.8.6',ready:true,time:Date.now()/1000,healthy:true,hddMounted:true,disk:{free:1000,total:2000,used:1000},capacity:{mode:'hd',freeHD:1,message:'1/2 HD hely szabad.'},sessions:[{ip:'192.168.1.240',name:'Tesztfilm',device:'LG TV',quality:'1080p',connections:1}],torrents:[{infoHash:'a'.repeat(40),name:'<img src=x onerror=alert(1)>',progress:.5,size:200,downloadRate:10,uploadRate:0,ratio:1,keep:false,active:true}],cleanup:{enabled:true,low_bytes:200,min_days:30,target_bytes:300},events:[],alerts:[],recoveryEnabled:true};
const dom = new JSDOM(html,{url:'http://fixture.local/control/',runScripts:'outside-only',pretendToBeVisual:true});
const w = dom.window;
w.AbortSignal = globalThis.AbortSignal;
let auth = true;
const actions=[];
w.fetch = async(path,init={})=>{
  if(path==='/api/login'){auth=true;return {ok:true,status:200,json:async()=>({success:true})};}
  if(!auth)return {ok:false,status:401,json:async()=>({})};
  if(path.endsWith('/action')){const body=JSON.parse(init.body);actions.push(body);return {ok:true,status:200,json:async()=>({ok:true})};}
  return {ok:true,status:200,json:async()=>structuredClone(state)};
};
w.eval(js);
const tick = ()=>new Promise(r=>setTimeout(r,30));
try {
  await tick();
  assert.equal(w.document.getElementById('dashboard').hidden,false);
  assert.match(w.document.getElementById('capacity').textContent,/1\/2/);
  assert.match(w.document.getElementById('sessions').textContent,/LG TV/);
  assert.match(w.document.getElementById('torrents').textContent,/<img/);
  assert.equal(w.document.getElementById('torrents').querySelector('img'),null);
  const checkbox=w.document.querySelector('input[type=checkbox]');
  checkbox.checked=true;checkbox.dispatchEvent(new w.Event('change'));
  await tick();
  assert.deepEqual(actions[0],{action:'keep',infoHash:'a'.repeat(40),keep:true});
  auth=false;w.document.getElementById('refresh').click();await tick();
  assert.equal(w.document.getElementById('login').hidden,false);
  assert.equal(w.document.getElementById('dashboard').hidden,true);
  const form=w.document.getElementById('loginForm');
  form.elements.namedItem('username').value='test';form.elements.namedItem('password').value='test-only';
  form.dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
  assert.equal(w.document.getElementById('dashboard').hidden,false);
  assert.equal(form.elements.namedItem('password').value,'');
  console.log('PASS: dashboard rendering, capacity, sessions, XSS escaping, keep action, login required, login form, password clearing.');
} finally {w.close();}
