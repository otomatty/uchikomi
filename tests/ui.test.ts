/** In-process React/DOM integration tests. These do not claim browser rendering or tabCapture coverage. */
import test, { before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { Phrase } from '../src/core/types';
import { buildAttempt } from '../src/core/analytics';

const browserWindow=new Window({url:'https://uchikomi.test/index.html',width:1440,height:1000});
const define=(name:string,value:unknown)=>Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
for(const name of ['window','document','navigator','location','history','HTMLElement','Element','HTMLInputElement','HTMLTextAreaElement','HTMLButtonElement','HTMLSelectElement','Event','KeyboardEvent','MouseEvent','FocusEvent','File','FileReader']) {
  define(name,name==='window'?browserWindow:(browserWindow as any)[name]);
}
define('requestAnimationFrame',browserWindow.requestAnimationFrame.bind(browserWindow));
define('cancelAnimationFrame',browserWindow.cancelAnimationFrame.bind(browserWindow));
define('indexedDB',new IDBFactory());define('IDBKeyRange',IDBKeyRange);
define('BroadcastChannel',class { onmessage:((value:unknown)=>void)|null=null; constructor(_name:string){} postMessage(_value:unknown){} close(){} });
define('IS_REACT_ACT_ENVIRONMENT',true);
// The process has no native focus manager; this fixture models an active foreground tab.
Object.defineProperty(browserWindow.document,'hasFocus',{configurable:true,value:()=>true});
Object.defineProperty(browserWindow.document,'hidden',{configurable:true,get:()=>false});
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {act}=React;
const {default:App}=await import('../src/app/App');
const {AppProvider}=await import('../src/app/shared');
const db=await import('../src/core/db');
let container:HTMLElement,root:ReturnType<typeof createRoot>|null;
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

async function settled(predicate:()=>boolean,message='UI did not settle',timeout=3000){
  const start=Date.now();
  while(!predicate()){
    if(Date.now()-start>timeout)throw new Error(`${message}\n${document.body.textContent?.slice(-1800)}`);
    await act(async()=>{await delay(10);});
  }
}
function query<T extends Element=HTMLElement>(selector:string):T {
  const value=document.querySelector<T>(selector);assert.ok(value,`Missing selector ${selector}`);return value;
}
function button(label:string,scope:ParentNode=document):HTMLButtonElement {
  const value=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);
  assert.ok(value,`Missing button '${label}'`);return value;
}
async function click(element:HTMLElement){await act(async()=>{element.focus();element.click();await delay(0);});}
async function input(element:HTMLInputElement|HTMLSelectElement,value:string){
  await act(async()=>{
    const proto=element instanceof HTMLSelectElement?browserWindow.HTMLSelectElement.prototype:browserWindow.HTMLInputElement.prototype;
    const set=Object.getOwnPropertyDescriptor(proto,'value')?.set;assert.ok(set);set.call(element,value);
    element.dispatchEvent(new browserWindow.Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));await delay(0);
  });
}
async function type(value:string){
  for(const key of value)await act(async()=>{const target=document.activeElement??document.body;target.dispatchEvent(new browserWindow.KeyboardEvent('keydown',{key,code:`Key${key.toUpperCase()}`,bubbles:true}));await delay(20);});
}
async function mount(){
  await act(async()=>{root!.render(React.createElement(AppProvider,null,React.createElement(App)));});
  await settled(()=>!!document.querySelector('[data-testid="app-shell"]'),'App did not load');
}
async function unmount(){if(root){await act(async()=>{root!.unmount();await delay(0);});root=null;}}
function phrase(id:string,text='テスト用のペアルック',reading='ぺあるっく',roman='pearukku'):Phrase {
  const at=Date.now();return {id,text,reading,roman,source:'manual',confidence:100,verified:true,capturedAt:at,lastSeenAt:at,seenCount:1};
}
async function navigateWords(){await click(query('[data-testid="nav-phrases"]'));}
async function closeModal(){await click(query('[role="dialog"] button[aria-label="閉じる"]'));}
async function openAdd(){await click(button('追加する'));await settled(()=>!!document.querySelector('[role="dialog"]'));}
async function fillPhrase(text:string,reading:string,roman:string){
  await input(query<HTMLInputElement>('input[placeholder="実際に出題されたキーワード"]'),text);
  await input(query<HTMLInputElement>('input[placeholder="ひらがなで入力"]'),reading);
  await input(query<HTMLInputElement>('input[placeholder="romaji"]'),roman);
}

before(async()=>{await db.clearData();});
beforeEach(async()=>{
  browserWindow.history.replaceState(null,'','/index.html');await db.clearData();
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await unmount();container.remove();await browserWindow.happyDOM.cancelAsync();});
after(async()=>{await browserWindow.happyDOM.close();});

test('UI first run contains no invented history or vocabulary',async()=>{
  await mount();const data=await db.getData();
  assert.equal(data.phrases.length,0);assert.equal(data.sessions.length,0);assert.equal(data.attempts.length,0);
  assert.match(document.body.textContent??'',/30,000/);assert.match(document.body.textContent??'',/開始時の目安/);
  await navigateWords();assert.equal(document.querySelectorAll('[data-testid="phrase-row"]').length,0);
});

test('phrase form rejects conflicting reading, and duplicate save-to-practice uses canonical ID',async()=>{
  await mount();await navigateWords();await openAdd();
  await fillPhrase('テスト用のペアルック','ぺあるっく','tukue');await click(button('保存'));
  assert.match(query('[role="alert"]').textContent??'',/一致しません/);assert.equal((await db.getData()).phrases.length,0);
  await input(query<HTMLInputElement>('input[placeholder="romaji"]'),'pearukku');await click(button('保存'));
  await settled(()=>!document.querySelector('[role="dialog"]'));
  const canonical=(await db.getData()).phrases[0];assert.ok(canonical.verified);
  await openAdd();await fillPhrase('テスト用のペアルック','ぺあるっく','pearukku');await click(button('保存して復習'));
  await settled(()=>!!document.querySelector('[data-testid="practice-start"]'));
  assert.equal((await db.getData()).phrases.length,1);
  await click(query('[data-testid="practice-start"]'));await settled(()=>!!document.querySelector('.roman-line .cursor'));
  await type('pearukku');await settled(()=>document.querySelector('.practice-count > span')?.textContent==='02');
  const data=await db.getData();assert.equal(data.attempts.length,1);assert.equal(data.attempts[0].phraseId,canonical.id);
  assert.ok(data.sessions.some(s=>s.id===data.attempts[0].sessionId));
});

test('filtered visible vocabulary drives actual practice; completed words and errors persist',async()=>{
  await db.savePhrase(phrase('ui-pair'));await db.savePhrase(phrase('ui-photo','テスト用の写真','しゃしん','syasinn'));await db.updateSettings({sessionLength:5});
  await mount();await navigateWords();await input(query<HTMLInputElement>('input[aria-label="キーワードを検索"]'),'ペアルック');
  assert.equal(document.querySelectorAll('[data-testid="phrase-row"]').length,1);
  await click(query('[data-testid="nav-practice"]'));await settled(()=>!!document.querySelector('[data-testid="practice-start"]'));
  await click(query('[data-testid="practice-start"]'));
  for(let i=0;i<5;i++){
    await settled(()=>Number(document.querySelector('.practice-count > span')?.textContent)===i+1&&!!document.querySelector('.roman-line .cursor'));
    if(i===0)await type('q');
    await type('pearukku');
  }
  await settled(()=>!!document.querySelector('[data-testid="practice-complete"]'));
  const data=await db.getData();assert.equal(data.attempts.length,5);assert.ok(data.attempts.every(a=>a.phraseId==='ui-pair'&&a.reliable&&a.complete));
  assert.equal(data.attempts.reduce((n,a)=>n+a.mistakes,0),1);
  const mistaken=data.attempts.find(a=>a.mistakes===1)!;
  assert.equal(mistaken.judgements?.[0].actual,'q');
  assert.equal(mistaken.judgements?.[0].accepted,false);
  assert.ok(mistaken.judgements?.[0].expected.includes('p'));
  const session=data.sessions.find(s=>s.id===data.attempts[0].sessionId)!;assert.ok(session.endedAt);assert.equal(session.phraseCount,5);
  assert.ok(data.attempts.some(a=>a.samples.some(s=>s.pattern==='kk')));
  await navigateWords();
  await click(query('[data-testid="filter-mistakes"]'));
  assert.equal(document.querySelectorAll('[data-testid="phrase-row"]').length,1);
  await click(query('button[aria-label="テスト用のペアルックを編集"]'));
  assert.equal(query('.confusion-row .key-wrong').textContent,'q');
  assert.equal(query('.confusion-row .key-correct').textContent,'p');
  assert.ok(document.querySelector('.trace-key.rejected'));
});

test('opening settings pauses practice and a partial run remains a valid restorable backup',async()=>{
  await db.savePhrase(phrase('ui-partial'));await mount();await navigateWords();
  await click(query('button[aria-label="テスト用のペアルックを復習"]'));await settled(()=>!!document.querySelector('[data-testid="practice-start"]'));
  await click(query('[data-testid="practice-start"]'));await settled(()=>!!document.querySelector('.roman-line .cursor'));await type('pearukku');
  await settled(()=>document.querySelector('.practice-count > span')?.textContent==='02');
  await click(query('[data-testid="nav-settings"]'));await settled(()=>!!document.querySelector('.pause-overlay'));
  await closeModal();assert.ok(document.querySelector('.pause-overlay'));
  await unmount();const exported=await db.exportData();assert.equal(exported.attempts.length,1);assert.ok(exported.sessions.length);
  await db.clearData();await db.importData(exported);assert.equal((await db.getData()).attempts.length,1);
});

test('negative profit can be recorded and charted; changing score basis keeps histories separate',async()=>{
  await mount();await click(button('スコアを記録'));await input(query<HTMLInputElement>('input[aria-label="スコア"]'),'-5000');await click(button('スコアを保存'));
  await settled(()=>!document.querySelector('[role="dialog"]'));assert.equal((await db.getData()).sessions[0].score,-5000);
  await click(query('[data-testid="nav-growth"]'));await settled(()=>!!document.querySelector('.score-chart'));
  const values=[...document.querySelectorAll('.score-chart circle')].map(c=>Number(c.getAttribute('cy')));
  assert.ok(values.length>0&&values.every(y=>y>=0&&y<=270),'Negative values should fit inside SVG');
  await click(query('[data-testid="nav-settings"]'));
  const select=[...document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')].find(s=>[...s.options].some(o=>o.value==='total'))!;
  await input(select,'total');await click(button('保存する'));await settled(()=>!document.querySelector('[role="dialog"]'));
  assert.ok(document.querySelector('.chart-empty'));assert.equal((await db.getData()).sessions[0].scoreType,'profit');
});

test('the actual import form rejects malformed JSON without changing records',async()=>{
  await db.savePhrase(phrase('ui-import'));await mount();await click(query('[data-testid="nav-settings"]'));
  const file=new browserWindow.File(['{"version":99}'],'invalid.json',{type:'application/json'});
  const transfer=new browserWindow.DataTransfer();transfer.items.add(file);
  await act(async()=>{const el=query<HTMLInputElement>('[data-testid="import-file"]');el.files=transfer.files as unknown as FileList;el.dispatchEvent(new browserWindow.Event('change',{bubbles:true}));await delay(20);});
  await settled(()=>!!document.querySelector('[role="dialog"] [role="alert"]'));
  assert.equal((await db.getData()).phrases.length,1);assert.match(query('[role="dialog"] [role="alert"]').textContent??'',/バックアップ/);
});

test('correct but slow letter combinations show the personal baseline and lead to five real-word repetitions',async()=>{
  const pair=phrase('ui-slow-pair'),photo=phrase('ui-fast-photo','テスト用の写真','しゃしん','syasinn');
  await db.savePhrase(pair);await db.savePhrase(photo);await db.updateSettings({sessionLength:5});
  const start=Date.now()-120000,sessionId='ui-speed-observations';
  await db.saveSession({id:sessionId,startedAt:start,endedAt:start+60000,source:'practice',scoreType:'profit',course:10000,mode:'accuracy',phraseCount:12,correctKeys:90,mistakes:0,durationMs:60000});
  for(let round=0;round<6;round++){
    for(const [p,offset] of [[pair,0],[photo,2000]] as const){
      const startedAt=start+round*5000+offset;let at=startedAt;
      const strokes=[...p.roman].map((key,index)=>{at+=p.id===pair.id&&index===6?320:80;return{key,at};});
      const observation=buildAttempt({phrase:p,strokes,startedAt,endedAt:at+80,sessionId,source:'practice',complete:true,reliable:true});
      assert.ok(observation.reliable&&observation.complete);assert.equal(observation.mistakes,0);
      await db.saveAttempt(observation);
    }
  }
  await mount();await navigateWords();
  // 42 intervals for the pair + 36 baseline intervals: (6*800+36*80)/78 = 98.46ms.
  assert.match(query('.baseline-strip').textContent??'',/10\.2/);
  assert.match(query('.baseline-detail').textContent??'',/98 ms \/ 打鍵 · 78 区間/);
  await click(query('[data-testid="filter-mistakes"]'));
  assert.equal(document.querySelectorAll('[data-testid="phrase-row"]').length,0);
  assert.match(document.body.textContent??'',/記録されたミスは、まだありません/);
  await click(query('[data-testid="filter-slow"]'));
  const slowPatterns=[...document.querySelectorAll('.slow-pattern strong')].map(el=>el.textContent);
  assert.ok(slowPatterns.includes('kk'));assert.ok(slowPatterns.includes('ukk'));assert.ok(slowPatterns.includes('kku'));
  assert.equal(document.querySelectorAll('[data-testid="phrase-row"]').length,1);
  assert.match(query('[data-testid="phrase-row"]').textContent??'',/テスト用のペアルック/);
  assert.ok([...document.querySelectorAll('.slow-mark')].some(el=>el.textContent?.includes('kk')));
  const kk=[...document.querySelectorAll<HTMLButtonElement>('button.slow-pattern')].find(el=>el.querySelector('strong')?.textContent==='kk');assert.ok(kk);
  await click(kk);assert.equal(query('.pattern-summary strong').textContent,'kk');
  assert.match(query('.pattern-summary').textContent??'',/ミスを含む 0区間/);
  assert.equal(document.querySelectorAll('[data-testid="phrase-row"]').length,1);
  await click(query('[data-testid="nav-practice"]'));await settled(()=>!!document.querySelector('[data-testid="practice-start"]'));
  await click(query('[data-testid="practice-start"]'));
  for(let i=0;i<5;i++){
    await settled(()=>Number(document.querySelector('.practice-count > span')?.textContent)===i+1&&!!document.querySelector('.roman-line .cursor'));
    assert.equal(query('.typing-phrase h1').textContent,pair.text);
    assert.equal(query('.roman-line').textContent,pair.roman);
    assert.equal(document.querySelectorAll('.roman-line .focus-letter').length,2);
    await type(pair.roman);
  }
  await settled(()=>!!document.querySelector('[data-testid="practice-complete"]'));
  const practiced=(await db.getData()).attempts.filter(a=>a.sessionId!==sessionId);
  assert.equal(practiced.length,5);assert.ok(practiced.every(a=>a.phraseId===pair.id&&a.complete&&a.reliable&&a.mistakes===0));
});
