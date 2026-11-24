/** In-process React/DOM integration tests. These do not claim browser rendering or tabCapture coverage. */
import test, { before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { MAX_SCORE, type Phrase } from '../src/core/types';
import { buildAttempt } from '../src/core/analytics';
import { trainingDateKey } from '../src/core/activity';

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
  const start=performance.now();
  while(!predicate()){
    if(performance.now()-start>timeout)throw new Error(`${message}\n${document.body.textContent?.slice(-1800)}`);
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
function assertTotalOnly(scope:Document|Element=document){
  assert.doesNotMatch((scope===document?document.body.textContent:scope.textContent)??'',/お得|利益|profit|スコアの基準/i);
  assert.equal(scope.querySelector('[aria-label="スコアの種類"]'),null);
  assert.equal(scope.querySelector('option[value="profit"],option[value="total"]'),null);
}
async function uploadBackup(value:unknown){
  const file=new browserWindow.File([JSON.stringify(value)],'legacy-backup.json',{type:'application/json'});
  const transfer=new browserWindow.DataTransfer();transfer.items.add(file);
  await act(async()=>{const el=query<HTMLInputElement>('[data-testid="import-file"]');el.files=transfer.files as unknown as FileList;el.dispatchEvent(new browserWindow.Event('change',{bubbles:true}));await delay(20);});
  await settled(()=>!document.querySelector('[role="dialog"]'));
}
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
  await click(button('苦手な単語'));
  assert.match(query('.words-empty').textContent??'',/苦手な単語はまだありません/);
  assert.equal(document.querySelector('[data-testid="nav-practice"]'),null);
});

test('weak word practice selects verified whole words with repeated misses or consistently slow input', async () => {
  const missed = phrase('missed', '赤', 'あか', 'aka');
  const slow = phrase('slow', '坂', 'さか', 'saka');
  const fast = phrase('fast', '魚', 'さかな', 'sakana');
  const unchecked = { ...phrase('unchecked', '傘', 'かさ', 'kasa'), verified: false };
  const observations = [
    { word: missed, keys: 'xaka', repeats: 2, gap: 80 },
    { word: slow, keys: 'saka', repeats: 3, gap: 300 },
    { word: fast, keys: 'sakana', repeats: 8, gap: 80 },
    { word: fast, keys: 'xxsakana', repeats: 1, gap: 80 },
    { word: fast, keys: 'xsakana', repeats: 1, gap: 80, reliable: false },
    { word: unchecked, keys: 'xkasa', repeats: 2, gap: 80 },
  ];
  for (const word of [missed, slow, fast, unchecked]) await db.savePhrase(word);
  let startedAt = Date.now() - 120000;
  for (const { word, keys, repeats, gap, reliable = true } of observations) {
    for (let i = 0; i < repeats; i++) {
      const strokes = [...keys].map((key, index) => ({ key, at: startedAt + (index + 1) * gap }));
      await db.saveAttempt(buildAttempt({ phrase: word, strokes, startedAt, endedAt: strokes.at(-1)!.at,
        sessionId: 'observed', source: 'practice', complete: true, reliable }));
      startedAt += 2000;
    }
  }
  await db.updateSettings({ sessionLength: 5 });
  await mount(); await navigateWords(); await click(button('苦手な単語'));
  const rows = [...document.querySelectorAll('[data-testid="phrase-row"]')];
  assert.deepEqual(rows.map(row => row.querySelector('strong')?.textContent), ['赤', '坂']);
  assert.match(rows[0].textContent ?? '', /入力2回中2回でミス/);
  assert.match(rows[1].textContent ?? '', /打鍵間隔が平均より/);
  await click(query('button[aria-label="坂を復習"]'));
  assert.equal(query('.typing-phrase h1').textContent, '坂');
  assert.deepEqual([...document.querySelectorAll('.practice-queue > span')].slice(1, 4).map(el => el.textContent), ['坂', '坂', '坂']);

  await navigateWords(); await click(button('苦手な単語')); await click(button('苦手な単語を練習'));
  await click(query('[data-testid="practice-start"]'));
  for (let i = 0; i < 5; i++) {
    await settled(() => Number(document.querySelector('.practice-count > span')?.textContent) === i + 1 && !!document.querySelector('.roman-line .cursor'));
    await type(query('.roman-line').textContent!);
  }
  await settled(() => !!document.querySelector('[data-testid="practice-complete"]'));
  const practiced = (await db.getData()).attempts.filter(attempt => attempt.sessionId !== 'observed');
  assert.equal(practiced.length, 5);
  assert.deepEqual(new Set(practiced.map(attempt => attempt.phraseId)), new Set([missed.id, slow.id]));
});

test('practice a weak clause alone, retain its parent on backup restore, and reopen the same drill from the panel link', async () => {
  const p = phrase('long-prompt','開いた口が塞がらない','あいたくちがふさがらない','aitakutigahusagaranai');
  await db.savePhrase(p);
  const at = Date.now()-60000;
  await db.saveSession({id:'game', startedAt:at, endedAt:at+10000, source:'capture',scoreType:'total',course:10000,mode:'accuracy',phraseCount:2,correctKeys:12,mistakes:2,durationMs:10000});
  for (let i=0; i<2; i++) {
    const startedAt = at+i*2000;
    const strokes = [...'aitakux'].map((key,n)=>({key,at:startedAt+(n+1)*80}));
    await db.saveAttempt(buildAttempt({phrase:p,strokes,sessionId:'game',startedAt,endedAt:startedAt+1000,
      source:'capture',complete:false,reliable:true,endOnMistake:true}));
  }
  await mount(); await navigateWords(); await click(button('苦手な文節'));
  assert.equal(document.querySelectorAll('.clause-list li').length,1);
  assert.match(query('.clause-list').textContent??'',/口が.*くちが.*開いた口が塞がらない.*2回中2回でミス/);
  await click(query('button[aria-label="「口が」だけを5回練習"]'));
  await click(query('[data-testid="practice-start"]'));
  for (let i=0; i<5; i++) {
    await settled(()=>Number(document.querySelector('.practice-count > span')?.textContent)===i+1 && !!document.querySelector('.roman-line .cursor'));
    assert.equal(query('.typing-phrase h1').textContent,'口が');
    await type(i%2 ? 'kuchiga' : 'kutiga');
  }
  await settled(()=>!!document.querySelector('[data-testid="practice-complete"]'));
  const backup = await db.exportData();
  await unmount(); await db.clearData(); await db.importData(backup);
  const restored = await db.getData();
  assert.equal(restored.phrases.length,1);
  const drills = restored.attempts.filter(a=>a.clause);
  assert.equal(drills.length,5);
  assert.ok(drills.every(a=>a.phraseId===p.id && a.reliable && a.complete));
  assert.deepEqual(drills[0].clause,{text:'口が',reading:'くちが',start:3});
  const params = new URLSearchParams({phrase:p.id,clause:'口が',reading:'くちが',offset:'3'});
  browserWindow.history.replaceState(null,'','/index.html#practice?'+params);
  root=createRoot(container); await mount();
  assert.equal(query('.typing-phrase h1').textContent,'口が');
  await unmount();
  params.set('offset','0');
  browserWindow.history.replaceState(null,'','/index.html#practice?'+params);
  root=createRoot(container); await mount();
  assert.equal(document.querySelector('.typing-phrase'),null);
  assert.ok(document.querySelector('.clause-list'));
  await unmount();
  // A homophone correction retains the original drill history under its own wording.
  await db.updatePhrase(p.id,{text:'開いた朽ちが塞がらない'});
  const history = (await db.getData()).attempts.filter(a=>a.clause);
  assert.equal(history.length,5);
  assert.ok(history.every(a=>a.clause?.text==='口が' && !a.reliable));
});

test('daily training shows real per-day volume, zero days, older estimates and source breakdowns',async(t)=>{
  const now=Date.parse('2026-12-25T23:59:59.900+09:00');
  t.mock.method(Date,'now',()=>now);
  const today=trainingDateKey(Date.now()),yesterday=trainingDateKey(Date.now()-86400000);
  const at=Date.parse(`${today}T10:00:00+09:00`);
  const base={startedAt:at,endedAt:at+120000,scoreType:'total' as const,course:10000 as const,mode:'accuracy' as const,phraseCount:0,correctKeys:0,mistakes:0,durationMs:0};
  await db.saveSession({...base,id:'daily-capture',source:'capture',activity:[{date:today,activeMs:45000,keys:30,phrases:2}]});
  await db.saveSession({...base,id:'daily-practice',source:'practice',activity:[{date:today,activeMs:20000,keys:14,phrases:1}]});
  await db.saveSession({...base,id:'daily-legacy',source:'practice',startedAt:at-86400000,endedAt:at-86400000+10000,durationMs:10000,correctKeys:9,mistakes:1,phraseCount:1});
  await db.saveSession({...base,id:'daily-score-only',source:'manual',score:30000,phraseCount:999,correctKeys:999,durationMs:999000});
  await mount();await click(query('[data-testid="nav-growth"]'));
  assert.equal(query('[data-testid="daily-keys"]').textContent,'44打鍵');
  assert.equal(query('[data-testid="daily-time"]').textContent,'1分5秒');
  assert.equal(query('[data-testid="daily-phrases"]').textContent,'3語');
  assert.equal(document.querySelector('[data-testid="daily-estimated"]'),null);
  assert.match(query('.daily-breakdown').textContent??'',/寿司打1記録/);
  assert.match(query('.daily-breakdown').textContent??'',/UCHIKOMI 復習1セット/);
  assert.equal(document.querySelectorAll('.daily-bar').length,7);
  await input(query<HTMLInputElement>('input[aria-label="練習量を表示する日"]'),yesterday);
  assert.equal(query('[data-testid="daily-keys"]').textContent,'10打鍵');
  assert.equal(query('[data-testid="daily-time"]').textContent,'10秒');
  assert.match(query('[data-testid="daily-estimated"]').textContent??'',/概算/);
  await click(button('30日'));assert.equal(document.querySelectorAll('.daily-bar').length,30);
  await input(query<HTMLInputElement>('input[aria-label="練習量を表示する日"]'),trainingDateKey(Date.now()-60*86400000));
  assert.equal(query('[data-testid="daily-keys"]').textContent,'0打鍵');
  assert.match(query('.daily-empty').textContent??'',/この日の練習記録はありません/);
  await click(button('今日へ戻る'));
  assert.equal(query<HTMLInputElement>('input[aria-label="練習量を表示する日"]').value,today);
  assert.equal(query('[data-testid="daily-keys"]').textContent,'44打鍵');
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

test('editing a keyword preserves captures that arrive while its dialog is open',async()=>{
  const original={...phrase('ui-live-a'),source:'capture' as const,screenshot:'data:image/png;base64,AA=='};
  await db.savePhrase(original);
  await db.savePhrase({...original,id:'ui-live-b',lastSeenAt:original.lastSeenAt+1,screenshot:'data:image/png;base64,AQ=='});
  await mount();await navigateWords();
  await click(query('button[aria-label="テスト用のペアルックを編集"]'));
  assert.equal((await db.getData()).phrases[0].seenCount,2);
  await act(async()=>{
    await db.savePhrase({...original,id:'ui-live-c',lastSeenAt:original.lastSeenAt+2,screenshot:'data:image/png;base64,Ag==',tags:['追加の出題']});
    await delay(0);
  });
  const latest=(await db.getData()).phrases[0];assert.equal(latest.seenCount,3);
  await input(query<HTMLInputElement>('input[placeholder="実際に出題されたキーワード"]'),'確認したペアルック');
  await click(button('保存'));await settled(()=>!document.querySelector('[role="dialog"]'));
  const saved=(await db.getData()).phrases[0];
  assert.equal(saved.text,'確認したペアルック');assert.equal(saved.id,original.id);
  for(const field of ['seenCount','seenSources','lastSeenAt','screenshot','screenshots','tags'] as const)assert.deepEqual(saved[field],latest[field],field);
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

test('settings and manual scores use only nonnegative totals, which reach the cards and graph unchanged',async()=>{
  await mount();await click(query('[data-testid="nav-settings"]'));assertTotalOnly(query('[role="dialog"]'));
  const defaults=await db.getData();assert.equal(defaults.settings.targetScore,30000);assert.equal(defaults.settings.baselineScore,18000);assert.equal(defaults.settings.scoreType,'total');
  await click(button('保存する'));await settled(()=>!document.querySelector('[role="dialog"]'));
  await click(button('スコアを記録'));
  const amount=query<HTMLInputElement>('input[aria-label="スコア"]');assert.equal(amount.min,'0');
  assert.match(query('[role="dialog"]').textContent??'',/食べた金額の合計/);assertTotalOnly(query('[role="dialog"]'));
  await input(amount,'-1');
  // Exercise the submit guard as well as the browser's min attribute.
  await act(async()=>{query('form.score-form').dispatchEvent(new browserWindow.Event('submit',{bubbles:true,cancelable:true}));await delay(0);});
  assert.ok(document.querySelector('[role="dialog"] [role="alert"]'));assert.equal((await db.getData()).sessions.length,0);
  await input(amount,'0');await click(button('スコアを保存'));await settled(()=>!document.querySelector('[role="dialog"]'));
  await click(button('スコアを記録'));await input(query<HTMLInputElement>('input[aria-label="スコア"]'),'29740');await click(button('スコアを保存'));
  await settled(()=>!document.querySelector('[role="dialog"]'));
  const saved=(await db.getData()).sessions;
  assert.deepEqual(saved.map(s=>s.score).sort((a,b)=>a!-b!),[0,29740]);assert.ok(saved.every(s=>s.scoreType==='total'&&!('scoreProfit' in s)));
  assert.match(query('.goal-bottom').textContent??'',/29,740/);assertTotalOnly();
  await click(query('[data-testid="nav-growth"]'));await settled(()=>!!document.querySelector('.score-chart'));
  assert.match(query('.score-chart svg').getAttribute('aria-label')??'',/29740円/);
  assert.match(query('.chart-card').textContent??'',/食べた金額の合計/);assert.equal(document.querySelectorAll('.session-score').length,2);
  assert.ok([...document.querySelectorAll('.session-score')].every(el=>el.textContent?.includes('合計')));
  const values=[...document.querySelectorAll('.score-chart circle')].map(c=>Number(c.getAttribute('cy')));
  assert.ok(values.length>0&&values.every(y=>Number.isFinite(y)&&y>=0&&y<=270));assertTotalOnly();
});

test('legacy profit backups restore through settings as totals and do not convert again after reload or export',async()=>{
  const current=await db.exportData(),now=Date.now(),evidence='data:image/png;base64,AA==';
  const base={source:'capture',course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:1000};
  const backup={...current,version:1,settings:{...current.settings,scoreType:'profit'},sessions:[
    {...base,id:'ui-legacy-gain',startedAt:now,endedAt:now+1000,score:19740,scoreType:'profit',scoreTotal:29740,scoreProfit:19740,scoreSource:'ocr',scoreConfidence:94,scoreEvidence:evidence},
    {...base,id:'ui-legacy-loss',startedAt:now-2000,endedAt:now-1000,score:-5000,scoreType:'profit'},
    {...base,id:'ui-existing-total',startedAt:now-4000,endedAt:now-3000,score:23000,scoreType:'total'},
  ]};
  await mount();await click(query('[data-testid="nav-settings"]'));await uploadBackup(backup);
  const restored=await db.getData(),byId=new Map(restored.sessions.map(s=>[s.id,s]));
  assert.equal(byId.get('ui-legacy-gain')?.score,29740);assert.equal(byId.get('ui-legacy-loss')?.score,5000);assert.equal(byId.get('ui-existing-total')?.score,23000);
  assert.equal(byId.get('ui-legacy-gain')?.scoreEvidence,evidence);assert.ok(restored.sessions.every(s=>s.scoreType==='total'&&!('scoreProfit' in s)));
  assert.equal(restored.settings.targetScore,30000);assert.equal(restored.settings.baselineScore,18000);assert.equal(restored.settings.scoreType,'total');
  assert.match(query('.goal-bottom').textContent??'',/29,740/);assertTotalOnly();
  await click(query('[data-testid="nav-growth"]'));await settled(()=>!!document.querySelector('.score-chart'));
  assert.match(query('.score-chart svg').getAttribute('aria-label')??'',/29740円/);assert.equal(document.querySelectorAll('.session-score').length,3);assertTotalOnly();
  await click(query('button[aria-label="29,740円の記録を編集"]'));
  assert.equal(query<HTMLInputElement>('input[aria-label="スコア"]').value,'29740');assertTotalOnly(query('[role="dialog"]'));await closeModal();
  await unmount();root=createRoot(container);await mount();
  assert.deepEqual((await db.getData()).sessions,restored.sessions);assertTotalOnly();
  const exported=await db.exportData();assert.ok(exported.sessions.every(s=>s.scoreType==='total'&&!('scoreProfit' in s)));
  await act(async()=>{await db.clearData();await db.importData(exported);await delay(20);});
  assert.deepEqual((await db.getData()).sessions,restored.sessions);
});

test('legacy review amounts are normalized to total before manual confirmation',async()=>{
  const current=await db.exportData(),now=Date.now();
  const backup={...current,version:1,sessions:[{id:'ui-mixed-review',startedAt:now,endedAt:now+1000,source:'capture',score:20000,scoreType:'total',course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:1000,
    scoreReview:{score:15000,scoreType:'profit',confidence:60,observedAt:now,reason:'読み取りの確認'}}]};
  await db.importData(backup);await mount();await click(query('[data-testid="nav-growth"]'));
  await click(query('button[aria-label="20,000円の記録を編集"]'));
  assert.equal(query<HTMLInputElement>('input[aria-label="スコア"]').value,'25000');assertTotalOnly(query('[role="dialog"]'));
  await click(button('スコアを保存'));await settled(()=>!document.querySelector('[role="dialog"]'));
  const saved=(await db.getData()).sessions[0];
  assert.equal(saved.score,25000);assert.equal(saved.scoreType,'total');assert.equal(saved.scoreTotal,25000);assert.equal('scoreProfit' in saved,false);assert.equal(saved.scoreReview,undefined);
});

test('a migrated large total remains editable up to the same storage limit',async()=>{
  const backup=await db.exportData(),now=Date.now();
  await db.importData({...backup,sessions:[{id:'ui-large-total',startedAt:now,source:'manual',score:995000,scoreType:'profit',
    course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:0}]});
  await mount();await click(query('[data-testid="nav-growth"]'));
  await click(query('button[aria-label="1,005,000円の記録を編集"]'));
  const amount=query<HTMLInputElement>('input[aria-label="スコア"]');
  assert.equal(amount.value,'1005000');assert.equal(amount.max,String(MAX_SCORE));
  await click(button('スコアを保存'));await settled(()=>!document.querySelector('[role="dialog"]'));
  await act(async()=>{await delay(20);});
  assert.equal((await db.getData()).sessions[0].score,1005000);
  await click(query('button[aria-label="1,005,000円の記録を編集"]'));
  await input(query<HTMLInputElement>('input[aria-label="スコア"]'),String(MAX_SCORE+1));
  await act(async()=>{query('form.score-form').dispatchEvent(new browserWindow.Event('submit',{bubbles:true,cancelable:true}));await delay(0);});
  assert.ok(document.querySelector('[role="dialog"] [role="alert"]'));
  assert.equal((await db.getData()).sessions[0].score,1005000);
  await input(query<HTMLInputElement>('input[aria-label="スコア"]'),String(MAX_SCORE));
  await click(button('スコアを保存'));await settled(()=>!document.querySelector('[role="dialog"]'));
  await act(async()=>{await delay(20);});
  assert.equal((await db.getData()).sessions[0].score,MAX_SCORE);
});

test('score review shows both distinct evidence images while avoiding duplicate or empty images',async()=>{
  await mount();await click(query('[data-testid="nav-growth"]'));
  const first='data:image/png;base64,AA==',second='data:image/png;base64,AQ==',now=Date.now();
  const cases=[[first,second],[first,first],[first,undefined],[undefined,second]] as const;
  for(let i=0;i<cases.length;i++){
    const [saved,review]=cases[i],score=20000+i;
    await act(async()=>{await db.saveSession({id:`proof-${i}`,startedAt:now+i,source:'capture',score,scoreType:'total',
      course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:0,scoreEvidence:saved,
      scoreReview:{score:25000,scoreType:'total',confidence:60,observedAt:now,reason:'画像を確認してください',evidence:review}});await delay(0);});
    const selector=`button[aria-label="${score.toLocaleString('ja-JP')}円の記録を編集"]`;
    await settled(()=>!!document.querySelector(selector));await click(query(selector));
    const images=[...query('[role="dialog"]').querySelectorAll<HTMLImageElement>('.phrase-proof img')];
    assert.deepEqual(new Set(images.map(img=>img.getAttribute('src'))),new Set([saved,review].filter(Boolean)));
    assert.equal(images.length,new Set([saved,review].filter(Boolean)).size);
    if(images.length===2)assert.notEqual(images[0].alt,images[1].alt,'the two sources need distinct labels');
    await closeModal();
  }
});

test('conflicting legacy amounts stay out of the graph until a total is confirmed',async()=>{
  const current=await db.exportData(),now=Date.now(),evidence='data:image/png;base64,AA==';
  await db.importData({...current,version:1,sessions:[{id:'ui-conflicting-total',startedAt:now,endedAt:now+1000,source:'capture',
    score:19740,scoreType:'profit',scoreTotal:30000,scoreProfit:19740,scoreSource:'ocr',scoreEvidence:evidence,
    course:10000,mode:'accuracy',phraseCount:0,correctKeys:0,mistakes:0,durationMs:1000}]});
  await mount();await click(query('[data-testid="nav-growth"]'));
  assert.ok(document.querySelector('.chart-empty'));assert.equal(document.querySelector('.score-chart svg'),null);
  await click(button('スコアを確認'));
  assert.equal(query<HTMLInputElement>('input[aria-label="スコア"]').value,'');
  const dialog=query('[role="dialog"]');assert.match(dialog.textContent??'',/29,?740/);assert.match(dialog.textContent??'',/30,?000/);
  assert.equal(query('.phrase-proof img').getAttribute('src'),evidence);assertTotalOnly(dialog);
  await input(query<HTMLInputElement>('input[aria-label="スコア"]'),'29800');await click(button('スコアを保存'));
  await settled(()=>!document.querySelector('[role="dialog"]'));
  const saved=(await db.getData()).sessions[0];assert.equal(saved.score,29800);assert.equal(saved.scoreTotal,29800);assert.equal(saved.scoreType,'total');assert.equal(saved.scoreReview,undefined);
  assert.match(query('.score-chart svg').getAttribute('aria-label')??'',/29800円/);assertTotalOnly();
});

test('failed practice saves keep results and retry controls until the full attempt is persisted',async()=>{
  await db.savePhrase(phrase('ui-failed-practice'));await db.updateSettings({sessionLength:5});
  await mount();await navigateWords();await click(query('[data-testid="nav-practice"]'));await click(query('[data-testid="practice-start"]'));
  await settled(()=>!!document.querySelector('.roman-line .cursor'));
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args:Parameters<typeof original>){
    if(this.name==='attempts')throw new DOMException('Test storage is full','QuotaExceededError');
    return original.apply(this,args);
  };
  try {
    await type('pearukku');await settled(()=>!!document.querySelector('[data-testid="practice-view"] [role="alert"]'));
    await click(button('練習を終了'));await settled(()=>!!document.querySelector('[data-testid="practice-complete"]'));
    assert.ok(button('保存を再試行'));assert.equal(button('成長を見る').disabled,true);assert.equal(button('もう1セット').disabled,true);
    assert.equal((await db.getData()).attempts.length,0);
    await click(query('[data-testid="nav-growth"]'));assert.ok(document.querySelector('[data-testid="practice-complete"]'));
    IDBObjectStore.prototype.put=original;
    await click(button('保存を再試行'));await settled(()=>!document.querySelector('[data-testid="practice-complete"] [role="alert"]'));
    const attempts=(await db.getData()).attempts;assert.equal(attempts.length,1);assert.equal(attempts[0].typed,'pearukku');assert.ok(attempts[0].complete);
    await click(button('練習を終了'));await settled(()=>!document.querySelector('[data-testid="practice-view"]'));
  } finally {IDBObjectStore.prototype.put=original;}
});

test('the actual import form rejects malformed JSON without changing records',async()=>{
  await db.savePhrase(phrase('ui-import'));await mount();await click(query('[data-testid="nav-settings"]'));
  const file=new browserWindow.File(['{"version":99}'],'invalid.json',{type:'application/json'});
  const transfer=new browserWindow.DataTransfer();transfer.items.add(file);
  await act(async()=>{const el=query<HTMLInputElement>('[data-testid="import-file"]');el.files=transfer.files as unknown as FileList;el.dispatchEvent(new browserWindow.Event('change',{bubbles:true}));await delay(20);});
  await settled(()=>!!document.querySelector('[role="dialog"] [role="alert"]'));
  assert.equal((await db.getData()).phrases.length,1);assert.match(query('[role="dialog"] [role="alert"]').textContent??'',/バックアップ/);
});

test('the actual import form restores a backup larger than 30 MiB without dropping image evidence',async()=>{
  const backup=await db.exportData();
  // Generated data-URL payloads exercise file size and schema retention here;
  // the Chrome regression also covers decoding actual PNGs and UI downloads.
  const screenshot='data:image/png;base64,'+'A'.repeat(2700000);
  backup.phrases=Array.from({length:12},(_,i)=>({...phrase(`ui-large-${i}`,`大容量テスト${i}`),screenshot}));
  const file=new browserWindow.File([JSON.stringify(backup)],'large-backup.json',{type:'application/json'});
  assert.ok(file.size>30*1024*1024);
  await mount();await click(query('[data-testid="nav-settings"]'));
  const transfer=new browserWindow.DataTransfer();transfer.items.add(file);
  await act(async()=>{const el=query<HTMLInputElement>('[data-testid="import-file"]');el.files=transfer.files as unknown as FileList;el.dispatchEvent(new browserWindow.Event('change',{bubbles:true}));await delay(20);});
  await settled(()=>!document.querySelector('[role="dialog"]'),'Large backup was not restored',10000);
  const restored=await db.getData();
  const metadata=(phrases:Phrase[])=>phrases.map(({screenshot:_image,...p})=>p).sort((a,b)=>a.id.localeCompare(b.id));
  assert.deepEqual(metadata(restored.phrases),metadata(backup.phrases));
  assert.ok(restored.phrases.every(p=>p.screenshot===screenshot),'All image payloads must survive unchanged');
  assert.deepEqual(restored.settings,backup.settings);
  assert.equal(restored.attempts.length,0);assert.equal(restored.sessions.length,0);
});

test('correct but slow letter combinations show the personal baseline and lead to five real-word repetitions',async()=>{
  const pair=phrase('ui-slow-pair'),photo=phrase('ui-fast-photo','テスト用の写真','しゃしん','syasinn');
  await db.savePhrase(pair);await db.savePhrase(photo);await db.updateSettings({sessionLength:5});
  const start=Date.now()-120000,sessionId='ui-speed-observations';
  await db.saveSession({id:sessionId,startedAt:start,endedAt:start+60000,source:'practice',scoreType:'total',course:10000,mode:'accuracy',phraseCount:12,correctKeys:90,mistakes:0,durationMs:60000});
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
