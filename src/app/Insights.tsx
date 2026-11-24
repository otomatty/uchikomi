import { useMemo } from 'react';
import { ArrowRight, Check, Clock3, Gauge, Keyboard, TriangleAlert } from 'lucide-react';
import { analyzePatterns, analyzeWords, typingBaseline } from '../core/analytics';
import type { PatternStat } from '../core/types';
import { day, time, useApp } from './shared';

const keyLabel=(key:string)=>key===' '?'Space':key;

export function TypingInsightPanel({filter,onFilter,onPattern}:{filter:string;onFilter:(value:string)=>void;onPattern:(value:string)=>void}){
  const {data}=useApp();
  const words=useMemo(()=>analyzeWords(data.attempts,data.phrases),[data]);
  const patterns=useMemo(()=>analyzePatterns(data.attempts,data.phrases),[data]);
  const baseline=useMemo(()=>typingBaseline(data.attempts,data.phrases),[data]);
  const mistakes=words.filter(word=>word.mistakes>0);
  const slow=patterns.filter(pattern=>pattern.slow).sort((a,b)=>b.lostMs-a.lostMs);
  return <section className="typing-insights" aria-label="入力の分析">
    <div className="baseline-strip"><span><Gauge size={15}/>正解時の平均打鍵</span><strong>{baseline.kps===null?'—':baseline.kps.toFixed(1)}<small>打 / 秒</small></strong><span className="baseline-detail">{baseline.meanMs===null?'入力を記録すると、比較が始まります':`${Math.round(baseline.meanMs)} ms / 打鍵 · ${baseline.count} 区間`}</span></div>
    <div className="insight-grid">
      <button className={`insight-card mistake-card ${filter==='mistakes'?'selected':''}`} onClick={()=>onFilter(filter==='mistakes'?'':'mistakes')} data-testid="filter-mistakes">
        <span className="insight-icon"><TriangleAlert size={18}/></span><span className="insight-copy"><strong>ミスが多い言葉</strong><small>押し間違いから、練習する</small></span><span className="insight-count">{mistakes.length}<small>語</small></span><ArrowRight size={16}/>
      </button>
      <button className={`insight-card slow-card ${filter==='slow'?'selected':''}`} onClick={()=>onFilter(filter==='slow'?'':'slow')} data-testid="filter-slow">
        <span className="insight-icon"><Clock3 size={18}/></span><span className="insight-copy"><strong>平均より遅い並び</strong><small>正しく打てても、止まる場所</small></span><span className="insight-count">{slow.length}<small>組</small></span><ArrowRight size={16}/>
      </button>
    </div>
    {filter==='slow'&&<div className="slow-insight-list">
      {slow.length?<><div className="slow-pattern-grid">{slow.slice(0,12).map(pattern=><SlowPattern key={pattern.pattern} pattern={pattern} onClick={()=>onPattern(pattern.pattern)}/>)}</div><p className="microcopy">自分の平均より20%以上・20ms以上遅く、5回以上計測できた並びを表示します。</p></>:<p className="insight-empty">{baseline.count<20?'比較する入力を集めています。いつものプレイや復習を続けると、遅い並びが見えてきます。':'平均より明確に遅い並びは、まだ見つかっていません。'}</p>}
    </div>}
  </section>;
}

function SlowPattern({pattern,onClick}:{pattern:PatternStat;onClick:()=>void}){
  const mean=pattern.meanMs??0,baseline=pattern.baselineMs??0;
  return <button className="slow-pattern" onClick={onClick} aria-label={`${pattern.pattern}の語句を見る。打鍵間隔${Math.round(mean)}ミリ秒、自分の平均${Math.round(baseline)}ミリ秒`}>
    <span><strong className="mono">{pattern.pattern}</strong><small>+{Math.round(Math.max(0,mean-baseline))}ms</small></span>
    <div className="latency-comparison" aria-hidden="true"><i style={{width:`${mean?baseline/mean*100:0}%`}}/><i/></div>
    <span className="slow-pattern-caption">{Math.round(mean)}ms <span>/ 平均 {Math.round(baseline)}ms</span></span>
  </button>;
}

export function SlowHighlight({text,patterns}:{text:string;patterns:string[]}){
  const candidates=[...patterns].sort((a,b)=>b.length-a.length);
  const parts:React.ReactNode[]=[];
  for(let i=0;i<text.length;){const match=candidates.find(p=>text.startsWith(p,i));if(match){parts.push(<mark className="slow-mark" key={i}>{match}</mark>);i+=match.length;}else{parts.push(<span key={i}>{text[i]}</span>);i++;}}
  return <>{parts}</>;
}

export function PhrasePerformance({phraseId}:{phraseId:string}){
  const {data}=useApp();
  const word=useMemo(()=>analyzeWords(data.attempts,data.phrases).find(value=>value.phraseId===phraseId),[data,phraseId]);
  const confusions=word?.confusions??[];
  const observed=data.attempts.filter(attempt=>!attempt.clause&&attempt.phraseId===phraseId&&attempt.judgements?.length).sort((a,b)=>b.endedAt-a.endedAt);
  const attempts=observed.slice(0,3);
  const latestMistake=observed.find(attempt=>attempt.judgements!.some(key=>!key.accepted));
  if(latestMistake&&!attempts.some(attempt=>attempt.id===latestMistake.id))attempts.push(latestMistake);
  if(!word&&!attempts.length)return null;
  return <section className="phrase-performance" aria-label="この語句の入力記録">
    <h3><Keyboard size={16}/>この言葉の入力記録</h3>
    <div className="phrase-metrics"><div><span>ミス</span><strong>{word?.mistakes??'—'}<small>回</small></strong></div><div><span>平均打鍵間隔</span><strong>{word?.meanMs===null||word?.meanMs===undefined?'—':Math.round(word.meanMs)}<small>ms</small></strong></div><div><span>自分の平均比</span><strong className={word?.slow?'slow-text':''}>{word?.slowdownPct===null||word?.slowdownPct===undefined?'—':`${word.slowdownPct>0?'+':''}${Math.round(word.slowdownPct)}`}<small>%</small></strong></div></div>
    {!!confusions.length&&<div className="confusion-list"><div className="confusion-head"><span>実際の入力</span><span>正解の候補</span><span>回数</span></div>{confusions.slice(0,5).map((item,i)=><div className="confusion-row" key={i}><kbd className="key-wrong">{keyLabel(item.actual)}</kbd><span><ArrowRight size={13}/>{item.expected.map(key=><kbd className="key-correct" key={key}>{keyLabel(key)}</kbd>)}</span><strong>{item.count}<small>回</small></strong></div>)}</div>}
    {!!attempts.length&&<details className="key-history"><summary>最近の入力を一打ずつ確認<span>{attempts.length}件</span></summary><div className="key-legend"><span><i className="correct"/>正解</span><span><i className="wrong"/>ミス</span><small>文字に触れると、正解候補と間隔を表示</small></div>{attempts.map(attempt=><div className="key-attempt" key={attempt.id}><div className="key-attempt-heading"><span>{day(attempt.endedAt)} {time(attempt.endedAt)}</span><span>{attempt.source==='practice'?'復習':'寿司打'}{!attempt.reliable?' · 参考・集計対象外':attempt.errorTerminated?' · ミスで終了':''}</span></div><div className="key-trace">{attempt.judgements!.map((key,i)=>{const description=`${key.accepted?'正解':'ミス'}: ${keyLabel(key.actual)} / 正解候補 ${key.expected.map(keyLabel).join('・')}${key.intervalMs===undefined?'':` / ${Math.round(key.intervalMs)}ms`}`;return <span key={i} className={`trace-key ${key.accepted?'accepted':'rejected'}`} title={description} aria-label={description} role="img">{keyLabel(key.actual)}</span>;})}</div></div>)}<p className="microcopy">表示された読みと入力方式から照合した記録です。参考記録は苦手の集計に含めません。</p></details>}
    {word&&!word.mistakes&&<p className="clean-word"><Check size={13}/>確認できた入力では、ミスがありません</p>}
  </section>;
}
