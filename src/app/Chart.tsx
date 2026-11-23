import { useId, useMemo, useState } from 'react';
import { ArrowUpRight, Plus, TrendingUp } from 'lucide-react';
import type { Session } from '../core/types';
import { day, fmt, EmptyState } from './shared';

export function ScoreChart({sessions,target,onRecord,compact=false}:{sessions:Session[];target:number;onRecord:()=>void;compact?:boolean}){
  const id=useId().replaceAll(':','');const [hover,setHover]=useState<number|null>(null);
  const points=useMemo(()=>sessions.filter(s=>typeof s.score==='number'&&s.scoreType==='total'&&s.source!=='demo'&&s.source!=='practice').sort((a,b)=>a.startedAt-b.startedAt).slice(-20),[sessions]);
  if(!points.length)return <div className={`chart-empty ${compact?'compact':''}`}><div className="empty-grid" aria-hidden="true"><span/><span/><span/><span/><div className="grid-target">GOAL {fmt(target)}</div></div><EmptyState symbol={<TrendingUp size={24}/>} title="ここから、伸ばしていこう。" body="プレイ後のスコアを記録すると、成長が見えてきます。" action={<button className="button secondary small" onClick={onRecord}><Plus size={15}/>最初のスコアを記録</button>}/></div>;
  const W=760,H=compact?205:270,pad={l:52,r:24,t:34,b:37};
  const max=Math.max(target,...points.map(p=>p.score!))*1.1;
  const rawMin=Math.min(...points.map(p=>p.score!),target);
  const min=Math.max(0,rawMin*.65);
  const x=(i:number)=>pad.l+(W-pad.l-pad.r)*(points.length===1?.5:i/(points.length-1));
  const y=(s:number)=>pad.t+(H-pad.t-pad.b)*(1-(s-min)/(max-min||1));
  const line=points.map((s,i)=>`${i?'L':'M'} ${x(i)} ${y(s.score!)}`).join(' ');
  const area=`${line} L ${x(points.length-1)} ${H-pad.b} L ${x(0)} ${H-pad.b} Z`;
  const active=hover===null?points.length-1:Math.max(0,Math.min(hover,points.length-1));const current=points[active];
  const ticks=[0,1,2,3].map(i=>min+(max-min)*i/3);
  return <div className="score-chart"><div className="chart-readout"><span>{hover===null?'最新のスコア':day(current.startedAt)}</span><strong>{fmt(current.score!)}<small>円</small></strong><span className="chart-sample">{points.length}回の記録</span></div><svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`直近${points.length}回のスコア。最新${current.score}円。目標${target}円。`}>
    <defs><linearGradient id={`fill-${id}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#dd6947" stopOpacity=".16"/><stop offset="100%" stopColor="#dd6947" stopOpacity=".01"/></linearGradient></defs>
    {ticks.map((v,i)=><g key={i}><line x1={pad.l} x2={W-pad.r} y1={y(v)} y2={y(v)} stroke="#eeece6" strokeDasharray="3 5"/><text x={pad.l-12} y={y(v)+4} textAnchor="end" fill="#9a9c92" fontSize="11">{Math.round(v/1000)}k</text></g>)}
    <line x1={pad.l} x2={W-pad.r} y1={y(target)} y2={y(target)} stroke="#a9b4a4" strokeDasharray="5 5"/><text x={W-pad.r} y={y(target)-9} textAnchor="end" fill="#6c7c61" fontSize="10" letterSpacing="1">GOAL {fmt(target)}</text>
    {points.length>1&&<path d={area} fill={`url(#fill-${id})`}/>}<path d={line} fill="none" stroke="#d96946" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>
    {points.map((p,i)=><g key={p.id} onMouseEnter={()=>setHover(i)} onMouseLeave={()=>setHover(null)} onFocus={()=>setHover(i)} onBlur={()=>setHover(null)} tabIndex={0} role="img" aria-label={`${day(p.startedAt)} ${fmt(p.score!)}円`}><circle cx={x(i)} cy={y(p.score!)} r="16" fill="transparent"/><circle cx={x(i)} cy={y(p.score!)} r={active===i?5:3} fill={active===i?'#d96946':'white'} stroke="#d96946" strokeWidth="2"/>{(i===0||i===points.length-1||(points.length>5&&i===Math.floor(points.length/2)))&&<text x={x(i)} y={H-9} textAnchor="middle" fontSize="11" fill="#93968e">{day(p.startedAt)}</text>}</g>)}
  </svg></div>;
}
export function ProgressRing({value,total,size=108}:{value:number;total:number;size?:number}){const pct=Math.min(100,Math.max(0,value/total*100));const radius=42,stroke=2*Math.PI*radius;return <div className="progress-ring" style={{width:size,height:size}}><svg viewBox="0 0 100 100" aria-label={`目標の${Math.round(pct)}パーセント`}><circle cx="50" cy="50" r={radius} fill="none" stroke="#e8e5db" strokeWidth="5"/><circle cx="50" cy="50" r={radius} fill="none" stroke="#d76a48" strokeWidth="5" strokeLinecap="round" strokeDasharray={stroke} strokeDashoffset={stroke*(1-pct/100)} transform="rotate(-90 50 50)"/></svg><span><strong>{Math.round(pct)}<small>%</small></strong><span>TO GOAL</span></span></div>;}
