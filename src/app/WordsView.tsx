import { useMemo, useState } from 'react';
import { BookOpen, Check, MoreHorizontal, Play, Plus, ScanLine, Search, X } from 'lucide-react';
import type { PatternStat, Phrase } from '../core/types';
import { analyzeWords } from '../core/analytics';
import { day, EmptyState, Eyebrow, Highlight, useApp } from './shared';
import { SlowHighlight, TypingInsightPanel } from './Insights';

export default function WordsView({patterns,filter,setFilter,onEdit,onNew,onPractice}:{patterns:PatternStat[];filter:string;setFilter:(s:string)=>void;onEdit:(p:Phrase)=>void;onNew:()=>void;onPractice:(p?:string,phrase?:Phrase,pool?:Phrase[])=>void}){
  const {data}=useApp();
  const [search,setSearch]=useState(''),[sort,setSort]=useState('priority');
  const stats=useMemo(()=>new Map(analyzeWords(data.attempts,data.phrases).map(word=>[word.phraseId,word])),[data]);
  const pattern=patterns.find(p=>p.pattern===filter);
  const weakIds=new Set(patterns.filter(p=>p.confidence!=='low').slice(0,8).flatMap(p=>p.phraseIds));
  const slowIds=new Set(patterns.filter(p=>p.slow).flatMap(p=>p.phraseIds));
  const review=data.phrases.filter(p=>!p.verified).length;
  const words=data.phrases.filter(p=>filter==='review'?!p.verified:filter==='mistakes'?(stats.get(p.id)?.mistakes??0)>0:filter==='slow'?slowIds.has(p.id)||stats.get(p.id)?.slow:filter==='weak'?weakIds.has(p.id):pattern?p.roman.includes(pattern.pattern)||pattern.phraseIds.includes(p.id):true)
    .filter(p=>`${p.text} ${p.reading} ${p.roman}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a,b)=>{
      if(sort==='new')return b.lastSeenAt-a.lastSeenAt;
      if(sort==='name')return a.text.localeCompare(b.text,'ja');
      if(sort==='mistakes'||filter==='mistakes')return (stats.get(b.id)?.mistakes??0)-(stats.get(a.id)?.mistakes??0)||b.seenCount-a.seenCount;
      if(sort==='slow'||filter==='slow')return (stats.get(b.id)?.lostMs??0)-(stats.get(a.id)?.lostMs??0)||b.seenCount-a.seenCount;
      return Number(a.verified)-Number(b.verified)||b.seenCount-a.seenCount;
    });
  const emptyTitle=search?'一致するキーワードがありません':filter==='review'?'確認待ちのキーワードはありません':filter==='mistakes'?'記録されたミスは、まだありません':filter==='slow'?'遅い並びを含む言葉が、ここに集まります':filter==='weak'?'復習すると、苦手が見えてきます':'あなた専用の練習帳を、ここに。';
  return <>
    <div className="page-heading"><div><Eyebrow>YOUR WORD COLLECTION</Eyebrow><h1>苦手を、得意に変える。</h1><p>ミスした言葉と、入力が止まる場所から。</p></div><button className="button secondary" onClick={onNew}><Plus size={16}/>追加する</button></div>
    <TypingInsightPanel filter={filter} onFilter={setFilter} onPattern={setFilter}/>
    {patterns.length>0&&filter!=='slow'&&<div className="pattern-filter-strip"><span>集中ポイント</span>{patterns.slice(0,8).map(p=><button key={p.pattern} className={`pattern-chip ${filter===p.pattern?'selected':''}`} onClick={()=>setFilter(filter===p.pattern?'':p.pattern)}><span>{p.pattern}</span><small>{p.confidence==='low'?'計測中':p.slow?`+${Math.round((p.meanMs??0)-(p.baselineMs??0))}ms`:`ミス ${p.errors}区間`}</small></button>)}</div>}
    <div className="word-toolbar"><div className="word-tabs" role="group" aria-label="キーワードの絞り込み"><button className={!filter?'active':''} onClick={()=>setFilter('')}>すべて<span>{data.phrases.length}</span></button><button className={filter==='mistakes'?'active':''} onClick={()=>setFilter('mistakes')}>ミス</button><button className={filter==='slow'?'active':''} onClick={()=>setFilter('slow')}>遅れ</button><button className={filter==='review'?'active':''} onClick={()=>setFilter('review')}>要確認{review>0&&<span className="review-count">{review}</span>}</button></div><div className="word-search"><Search size={16}/><input aria-label="キーワードを検索" placeholder="キーワードを探す" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button aria-label="検索をクリア" onClick={()=>setSearch('')}><X size={14}/></button>}</div></div>
    {pattern&&<div className="pattern-summary"><div><span className="pattern-summary-text">集中ポイント</span><strong className="mono">{pattern.pattern}</strong><span>{pattern.count}回の記録<span className="bullet">·</span>ミスを含む {pattern.errors}区間<span className="bullet">·</span>平均 {pattern.meanMs===null?'—':Math.round(pattern.meanMs)}ms{pattern.slow&&<span className="slow-text"> / 自分の平均比 +{Math.round(pattern.slowdownPct??0)}%</span>}</span></div><button className="text-button" onClick={()=>setFilter('')}><X size={15}/>解除</button></div>}
    {words.length?<div className="word-collection"><div className="word-table-head"><span>キーワード / ローマ字</span><span>集中ポイント</span><span>入力の記録</span><label className="sr-only">並び順</label><select aria-label="並び順" value={sort} onChange={e=>setSort(e.target.value)}><option value="priority">確認・頻度順</option><option value="mistakes">ミスが多い順</option><option value="slow">入力の遅れ順</option><option value="new">新しい順</option><option value="name">名前順</option></select></div>{words.map(p=>{
      const word=stats.get(p.id),relevant=patterns.filter(s=>s.phraseIds.includes(p.id)).sort((a,b)=>filter==='slow'?Number(b.slow)-Number(a.slow):0).slice(0,2);
      return <div className="word-row" key={p.id} data-testid="phrase-row"><button className="word-info" onClick={()=>onEdit(p)}><span className={`word-state ${p.verified?'verified':''}`}>{p.verified?<Check size={14}/>:<ScanLine size={15}/>}</span><span><strong>{p.text}</strong><span className="word-roman mono">{filter==='slow'?<SlowHighlight text={p.roman} patterns={word?.slowPatterns??[]}/>:<Highlight text={p.roman} pattern={pattern?.pattern}/>}</span></span></button><div className="word-patterns">{relevant.length?relevant.map(s=><button className={`mini-pattern ${s.slow?'slow-pattern-chip':''}`} key={s.pattern} onClick={()=>setFilter(s.pattern)} title={s.slow?'平均より遅い並び':undefined}>{s.pattern}</button>):<span className="muted tiny">{p.verified?'復習で分析':'読み取りを確認'}</span>}</div><span className={`word-meta ${filter==='slow'&&word?.slow?'slow-text':''}`}>{word?(filter==='slow'?`${word.meanMs===null?'—':Math.round(word.meanMs)} ms`:`${word.mistakes} ミス`):p.source==='manual'?'未計測':`${p.seenCount} 回出題`}<small>{word?(filter==='slow'&&word.slowdownPct!==null?`平均比 ${word.slowdownPct>=0?'+':''}${Math.round(word.slowdownPct)}%`:`${word.attempts} 回の入力`):day(p.lastSeenAt)}</small></span><div className="word-actions">{p.verified?<button className="icon-button" aria-label={`${p.text}を復習`} onClick={()=>onPractice(pattern?.pattern,p)}><Play size={17}/></button>:<button className="button review-button small" onClick={()=>onEdit(p)}>確認する</button>}<button className="icon-button" aria-label={`${p.text}を編集`} onClick={()=>onEdit(p)}><MoreHorizontal size={18}/></button></div></div>;
    })}</div>:<div className="words-empty"><EmptyState symbol={<BookOpen size={30}/>} title={emptyTitle} body={search?'別の言葉やローマ字で探してみてください。':filter==='review'?'すべて確認済みです。そのまま復習へ。':'寿司打や復習での入力から、自動で記録します。'} action={<button className="button secondary" onClick={onNew}><Plus size={16}/>キーワードを追加</button>}/></div>}
    {words.some(p=>p.verified)&&<div className="word-practice-bar"><span><span className="green-dot"/>{words.filter(p=>p.verified).length}語から練習できます</span><button className="button primary" data-testid="nav-practice" onClick={()=>onPractice(pattern?.pattern,undefined,words.filter(p=>p.verified))}>{data.settings.sessionLength}語を復習<Play size={16}/></button></div>}
  </>;
}
