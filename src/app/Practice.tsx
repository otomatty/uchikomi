import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCheck, CirclePause, CornerDownLeft, Keyboard, Play, RotateCcw, X } from 'lucide-react';
import type { Attempt, KeyStroke, PracticePhrase, Session } from '../core/types';
import { createMatcher } from '../core/romaji';
import { buildAttempt } from '../core/analytics';
import { TrainingActivity } from '../core/activity';
import { saveAttempt, saveSession } from '../core/db';
import { Brand, fmt, Highlight, Spinner, uid, useApp } from './shared';

type RunState='ready'|'starting'|'running'|'paused'|'between'|'finished';
export default function Practice({queue,pattern,onExit,onAgain,onUnsavedChange}:{queue:PracticePhrase[];pattern?:string;onExit:()=>void;onAgain:()=>void;onUnsavedChange?:(unsaved:boolean)=>void}){
  const {notify}=useApp();const [state,setState]=useState<RunState>('ready');const [index,setIndex]=useState(0),[progress,setProgress]=useState(0);
  const [display,setDisplay]=useState(queue[0]?.roman||'');const [flash,setFlash]=useState(false),[ime,setIme]=useState(false);
  const [results,setResults]=useState<Attempt[]>([]),[saving,setSaving]=useState(false),[seconds,setSeconds]=useState(0),[persistenceError,setPersistenceError]=useState('');
  const session=useRef({id:uid(),at:Date.now()});const matcher=useRef(createMatcher(queue[0]?.reading||'',queue[0]?.roman||''));
  const strokes=useRef<KeyStroke[]>([]),phraseAt=useRef(0),pauseAt=useRef(0),paused=useRef(0),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const stateRef=useRef<RunState>('ready');const surface=useRef<HTMLDivElement>(null);const mounted=useRef(true),exiting=useRef(false);
  const savedIds=useRef(new Set<string>()),writes=useRef<Promise<void>>(Promise.resolve()),finishTask=useRef<Promise<boolean>|null>(null);
  const phrase=queue[index];const resultRef=useRef<Attempt[]>([]);
  const activity=useRef(new TrainingActivity()),activityRevision=useRef(0),savedActivityRevision=useRef(0);
  const checkpointPending=useRef(false),checkpointWarned=useRef(false);
  const changeState=(next:RunState)=>{stateRef.current=next;if(mounted.current)setState(next);};
  const sessionValue=(list:Attempt[],endedAt?:number):Session=>({id:session.current.id,startedAt:session.current.at,...(endedAt?{endedAt}:{}),source:'practice',scoreType:'total',course:10000,mode:'accuracy',phraseCount:list.length,correctKeys:list.reduce((n,a)=>n+a.correctKeys,0),mistakes:list.reduce((n,a)=>n+a.mistakes,0),durationMs:list.reduce((n,a)=>n+a.durationMs,0),activity:activity.current.snapshot()});
  const persist=(list:Attempt[],endedAt?:number)=>{
    // Serialize writes so leaving during the inter-word transition cannot overwrite a later result.
    const value=sessionValue(list,endedAt),revision=activityRevision.current;
    const task=writes.current.catch(()=>{}).then(async()=>{for(const attempt of list){if(!savedIds.current.has(attempt.id)){await saveAttempt(attempt);savedIds.current.add(attempt.id);}}await saveSession(value);savedActivityRevision.current=Math.max(savedActivityRevision.current,revision);});
    writes.current=task;return task;
  };
  const checkpoint=async(force=false)=>{
    if(activityRevision.current<=savedActivityRevision.current||(!force&&checkpointPending.current))return;
    if(!force)checkpointPending.current=true;
    try{await persist(resultRef.current);checkpointWarned.current=false;if(mounted.current)setPersistenceError('');}
    catch{if(mounted.current)setPersistenceError('練習記録を保存できていません。終了時に再試行します。');if(!checkpointWarned.current){checkpointWarned.current=true;notify('練習記録を保存できませんでした。','error');}}
    finally{if(!force)checkpointPending.current=false;}
  };
  const prepare=(i:number)=>{matcher.current=createMatcher(queue[i].reading,queue[i].roman);setDisplay(matcher.current.display);setProgress(0);strokes.current=[];phraseAt.current=Date.now();paused.current=0;setIme(false);};
  const start=async()=>{
    if(stateRef.current!=='ready')return;changeState('starting');setPersistenceError('');
    session.current={id:uid(),at:Date.now()};savedIds.current.clear();finishTask.current=null;exiting.current=false;setSeconds(0);
    activity.current=new TrainingActivity();activityRevision.current=savedActivityRevision.current=0;checkpointPending.current=checkpointWarned.current=false;
    try{await saveSession(sessionValue([]));if(!mounted.current||exiting.current)return;prepare(0);changeState('running');surface.current?.focus();}
    catch{changeState('ready');setPersistenceError('練習記録を保存できません。空き容量を確認して再試行してください。');notify('練習を開始できませんでした。','error');}
  };
  const pause=()=>{if(stateRef.current==='running'){pauseAt.current=Date.now();activity.current.break();setSeconds(Math.floor(activity.current.snapshot().reduce((sum,row)=>sum+row.activeMs,0)/1000));changeState('paused');void checkpoint(true);}};
  const resume=()=>{if(stateRef.current!=='paused')return;const duration=Date.now()-pauseAt.current;paused.current+=duration;changeState('running');surface.current?.focus();};
  useEffect(()=>{onUnsavedChange?.(!!persistenceError&&(resultRef.current.length>0||activityRevision.current>0));},[persistenceError,onUnsavedChange]);
  useEffect(()=>{
    mounted.current=true;
    const t=setInterval(()=>{if(stateRef.current==='running')setSeconds(Math.floor(activity.current.snapshot().reduce((sum,row)=>sum+row.activeMs,0)/1000));},250);
    const saving=setInterval(()=>{if(stateRef.current==='running')void checkpoint();},5000);
    const onPageHide=()=>{activity.current.break();if(stateRef.current==='running'||stateRef.current==='paused'||stateRef.current==='between')void checkpoint(true);};
    window.addEventListener('pagehide',onPageHide);
    return()=>{mounted.current=false;clearInterval(t);clearInterval(saving);window.removeEventListener('pagehide',onPageHide);if(timer.current)clearTimeout(timer.current);};
  },[]);
  useEffect(()=>{const onHidden=()=>{if(document.hidden)pause();};const onFocus=(event:FocusEvent)=>{const target=event.target;if(stateRef.current==='running'&&target instanceof Element&&!surface.current?.contains(target)&&!target.closest('[data-practice-pause]'))pause();};window.addEventListener('blur',pause);document.addEventListener('visibilitychange',onHidden);document.addEventListener('focusin',onFocus);return()=>{window.removeEventListener('blur',pause);document.removeEventListener('visibilitychange',onHidden);document.removeEventListener('focusin',onFocus);};},[]);
  const finish=(list:Attempt[])=>{
    if(finishTask.current)return finishTask.current;activity.current.break();setSeconds(Math.floor(activity.current.snapshot().reduce((sum,row)=>sum+row.activeMs,0)/1000));exiting.current=true;if(timer.current)clearTimeout(timer.current);setSaving(true);changeState('between');
    finishTask.current=(async()=>{let saved=false;try{await persist(list,Date.now());saved=true;if(mounted.current)setPersistenceError('');return true;}catch{if(mounted.current)setPersistenceError('結果の保存が完了していません。下のボタンで再試行できます。');notify('復習結果を保存できませんでした。','error');return false;}finally{if(!saved)finishTask.current=null;if(mounted.current){setSaving(false);changeState('finished');}}})();
    return finishTask.current;
  };
  const leave=async()=>{if(stateRef.current==='ready'){onExit();return;}if(stateRef.current==='starting'||saving)return;if(stateRef.current==='finished'&&!persistenceError){onExit();return;}if(await finish(resultRef.current))onExit();};
  const retrySave=async()=>{setSaving(true);try{await persist(resultRef.current,Date.now());setPersistenceError('');notify('復習結果を保存しました');}catch{setPersistenceError('まだ保存できません。空き容量を確認して再試行してください。');}finally{setSaving(false);}};
  useEffect(()=>{
    const handle=async(e:KeyboardEvent)=>{
      const currentState=stateRef.current;
      if(e.key==='Escape'&&!e.repeat){e.preventDefault();if(currentState==='running')pause();else if(currentState==='paused')resume();return;}
      if(e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)return;
      if(currentState==='ready'&&e.code==='Space'){e.preventDefault();void start();return;}
      if(currentState==='paused'&&e.code==='Space'){e.preventDefault();resume();return;}
      if(currentState!=='running'||e.repeat||e.ctrlKey||e.metaKey||e.altKey)return;
      if(e.isComposing||e.key==='Process'||e.key==='Unidentified'){setIme(true);return;}
      if(e.key.length!==1)return;e.preventDefault();setIme(false);
      const physicalAt=Date.now(),at=physicalAt-paused.current;
      activity.current.recordKey(physicalAt);activity.current.recordPhrase(`${session.current.id}:${index}`,physicalAt);activityRevision.current++;
      strokes.current.push({key:e.key.toLowerCase(),code:e.code,at});
      const answer=matcher.current.feed(e.key.toLowerCase());
      if(!answer.accepted){setFlash(true);setTimeout(()=>{if(mounted.current)setFlash(false);},160);return;}
      setProgress(answer.position);setDisplay(answer.display);
      if(answer.complete){
        activity.current.break();changeState('between');
        const attempt=buildAttempt({phrase,strokes:strokes.current,startedAt:phraseAt.current,endedAt:at,sessionId:session.current.id,source:'practice',complete:true,reliable:true});
        const list=[...resultRef.current,attempt];setResults(list);resultRef.current=list;
        try{await persist(list);}catch{setPersistenceError('一部の結果を保存できていません。終了時に再試行します。');notify('この語句の結果を保存できませんでした。','error');}
        if(!mounted.current||exiting.current)return;
        if(index+1>=queue.length){void finish(list);return;}
        timer.current=setTimeout(()=>{if(!mounted.current||exiting.current)return;setIndex(i=>i+1);prepare(index+1);if(document.hidden||!document.hasFocus()){pauseAt.current=Date.now();changeState('paused');}else changeState('running');},300);
      }
    };window.addEventListener('keydown',handle);return()=>window.removeEventListener('keydown',handle);
  },[index,phrase,queue]);
  const totalKeys=results.reduce((n,a)=>n+a.correctKeys,0),totalErrors=results.reduce((n,a)=>n+a.mistakes,0),totalMs=results.reduce((n,a)=>n+a.durationMs,0);
  const accuracy=totalKeys+totalErrors?100*totalKeys/(totalKeys+totalErrors):100;
  const kps=totalMs?totalKeys/(totalMs/1000):0;
  if(!phrase)return null;
  return <div className="practice-page" data-testid="practice-view"><div className="practice-top"><button className="text-button" disabled={state==='starting'||saving} onClick={()=>void leave()}><ArrowLeft size={17}/>練習を終了</button><span className="mode-tag">{phrase.clause?'文節の反復練習':'集中トレーニング'}</span><span className="mono muted" title="入力時間" aria-label="入力時間">{String(Math.floor(seconds/60)).padStart(2,'0')}:{String(seconds%60).padStart(2,'0')}</span></div>
  {state==='finished'?<div className="practice-summary" data-testid="practice-complete"><span className="completion-mark"><CheckCheck size={40}/></span><span className="eyebrow">NICE SESSION</span><h1>今日も、一歩前へ。</h1><p>{phrase.clause ? `「${phrase.text}」を${results.length}回練習しました。` : `${results.length}語の復習が完了しました。`}</p>{persistenceError&&<div role="alert"><p className="inline-error">{persistenceError}</p><button className="button secondary" disabled={saving} onClick={()=>void retrySave()}>{saving?<Spinner/>:<RotateCcw size={16}/>}保存を再試行</button></div>}<div className="result-stats"><div><strong>{accuracy.toFixed(1)}<small>%</small></strong><span>正確率</span></div><div><strong>{kps.toFixed(2)}<small>key/s</small></strong><span>入力速度</span></div><div><strong>{totalErrors}<small>回</small></strong><span>ミスタイプ</span></div></div><div className="result-words">{results.map((a,i)=><div key={a.id}><span>{queue[i]?.text||'キーワード'}</span><span className={a.mistakes?'orange-text':'green-text'}>{a.mistakes?`${a.mistakes} ミス`:<><Check size={13}/>ノーミス</>}</span><strong className="mono">{a.kps.toFixed(1)}<small> key/s</small></strong></div>)}</div><div className="button-row"><button className="button secondary" disabled={saving||!!persistenceError} onClick={onExit}>成長を見る<ArrowRight size={16}/></button><button className="button primary" disabled={saving||!!persistenceError} onClick={onAgain}><RotateCcw size={17}/>もう1セット</button></div></div>:<>
    <div className="practice-progress" aria-label={`${index+1}語目、全${queue.length}語`}><div style={{width:`${index/queue.length*100}%`}}/></div>
    <div className={`typing-stage ${flash?'mistake':''} ${state==='paused'?'paused':''}`} tabIndex={0} ref={surface} data-testid="practice-input" aria-label="タイピング練習。半角英数で入力。Escapeで一時停止。" onClick={()=>surface.current?.focus()}>
      <div className="practice-count"><span>{String(index+1).padStart(2,'0')}</span><span>/ {String(queue.length).padStart(2,'0')}</span></div>
      {pattern&&<div className="focus-badge"><span/>重点トレーニング <strong className="mono">{pattern}</strong></div>}
      <div className="typing-phrase"><p className="kana">{phrase.reading||'\u00a0'}</p><h1>{phrase.text}</h1><div className="roman-line" aria-label={`${display}、${progress}文字入力済み`}>{display.split('').map((char,i)=><span key={i} className={`${i<progress?'typed':''} ${i===progress&&state==='running'?'cursor':''} ${pattern&&display.indexOf(pattern)>=0&&i>=display.indexOf(pattern)&&i<display.indexOf(pattern)+pattern.length?'focus-letter':''}`}>{char===' '?'\u00a0':char}</span>)}</div></div>
      {state==='ready'&&<div className="practice-ready"><button className="button primary" data-testid="practice-start" onClick={()=>void start()}><Play size={17} fill="currentColor"/>練習をはじめる</button><span className="key-hint"><kbd>Space</kbd> でも開始</span></div>}
      {state==='starting'&&<div className="practice-ready"><Spinner/><span>記録を準備しています</span></div>}{state==='paused'&&<div className="pause-overlay"><span className="pause-symbol"><CirclePause size={34}/></span><h2>ひと息、入れよう。</h2><button className="button primary" onClick={resume}><Play size={17}/>再開する</button><span className="key-hint"><kbd>Space</kbd> または <kbd>Esc</kbd></span></div>}
      {state==='running'&&<div className="typing-status">{ime?<span className="inline-error">半角英数に切り替えてください</span>:<><span className="live-dot"/>入力に集中しよう</>}</div>}
      {state==='between'&&<div className="typing-status green-text"><Check size={16}/>{saving?'結果を保存中':'いい調子。'}</div>}
    </div>
    {persistenceError&&<p className="inline-error" role="alert">{persistenceError}</p>}<div className="practice-bottom"><div><span className="muted">正確率</span><strong>{results.length?accuracy.toFixed(1):'—'}<small>%</small></strong></div><div><span className="muted">入力速度</span><strong>{results.length?kps.toFixed(2):'—'}<small>key/s</small></strong></div><button className="text-button muted" data-practice-pause onClick={state==='paused'?resume:pause} disabled={state!=='running'&&state!=='paused'}><CirclePause size={16}/><kbd>Esc</kbd>一時停止</button></div>
    <div className="practice-queue"><span>このセット</span>{queue.slice(index+1,index+4).map((p,i)=><span key={p.id+i}>{p.text}</span>)}{index+4<queue.length&&<span>+{queue.length-index-4}</span>}</div>
  </>}
  </div>;
}
