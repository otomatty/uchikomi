import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Clock3, Keyboard, Layers } from 'lucide-react';
import type { AppData } from '../core/types';
import { dailyTraining, trainingDateKey, validTrainingDate, type DailyTrainingRow } from '../core/activity';
import { fmt } from './shared';

const DAY = 86400000;
const shiftDay = (date:string, delta:number) => trainingDateKey(Date.parse(`${date}T12:00:00+09:00`) + delta * DAY);
const shortDay = (date:string) => `${Number(date.slice(5,7))}/${Number(date.slice(8))}`;
const dayLabel = (date:string) => new Intl.DateTimeFormat('ja-JP',{month:'long',day:'numeric',weekday:'short',timeZone:'Asia/Tokyo'}).format(new Date(`${date}T12:00:00+09:00`));
export function activityTime(ms:number):string {
  const seconds=Math.floor(ms/1000);
  if(ms>0&&seconds===0)return '1秒未満';
  if(seconds<60)return `${seconds}秒`;
  if(seconds<3600)return `${Math.floor(seconds/60)}分${seconds%60?`${seconds%60}秒`:''}`;
  return `${Math.floor(seconds/3600)}時間${Math.floor(seconds%3600/60)}分`;
}

export default function DailyTraining({data}:{data:AppData}) {
  const [today,setToday]=useState(()=>trainingDateKey(Date.now()));
  useEffect(()=>{
    const update=()=>setToday(trainingDateKey(Date.now()));
    const timer=window.setInterval(update,30000);
    window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);
    return()=>{window.clearInterval(timer);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};
  },[]);
  const [days,setDays]=useState(7),[endDate,setEndDate]=useState<string|null>(null),[selected,setSelected]=useState<string|null>(null);
  const end=endDate??today;
  const summary=useMemo(()=>dailyTraining(data,{today:end,days}),[data,end,days]);
  const selectedDate=selected??end;
  const selectedRow=summary.rows.find(row=>row.date===selectedDate)??summary.today;
  const maxKeys=Math.max(1,...summary.rows.map(row=>row.keys));
  const hasActivity=selectedRow.keys>0||selectedRow.phrases>0||selectedRow.activeMs>0;
  const selectDay=(date:string)=>{
    if(!validTrainingDate(date)||date<'1970-01-01'||date>today)return;
    setSelected(date);
    if(date<summary.from||date>summary.to)setEndDate(date);
  };
  const goToday=()=>{setSelected(null);setEndDate(null);};
  const changeRange=(next:number)=>{setDays(next);if(selected&&selected<shiftDay(end,1-next)){setEndDate(selected);}};
  const moveSelection=(event:React.KeyboardEvent<HTMLButtonElement>,row:DailyTrainingRow)=>{
    const delta=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0;
    if(!delta)return;
    event.preventDefault();
    const index=summary.rows.findIndex(value=>value.date===row.date),next=summary.rows[index+delta];
    if(next&&next.date>='1970-01-01'){selectDay(next.date);(event.currentTarget.parentElement?.querySelector(`[data-day="${next.date}"]`) as HTMLButtonElement|null)?.focus();}
  };

  return <section className="daily-training" data-testid="daily-training" aria-labelledby="daily-heading">
    <header className="daily-header">
      <div><span className="eyebrow">YOUR DAILY PRACTICE</span><h2 id="daily-heading">毎日の練習量</h2></div>
      <div className="daily-ranges" role="group" aria-label="表示期間">{[7,30,90].map(value=><button key={value} type="button" aria-pressed={days===value} onClick={()=>changeRange(value)}>{value}日</button>)}</div>
    </header>
    <div className="daily-period"><span>{shortDay(summary.from)} — {shortDay(summary.to)}<small>日本時間</small></span><span><strong>{summary.activeDays}</strong> / {days} 日に記録</span></div>
    <div className="daily-chart-heading"><span>打鍵数の推移</span><div className="daily-legend"><span><i className="daily-capture"/>寿司打</span><span><i className="daily-practice"/>復習</span></div></div>
    <div className={`daily-bars ${days>7?'dense':''}`} style={{gridTemplateColumns:`repeat(${summary.rows.length}, minmax(0, 1fr))`}} role="group" aria-label="日別の打鍵数。日を選ぶと内訳を表示。左右矢印でも移動できます。">
      {summary.rows.map((row,index)=>{
        const active=row.date===selectedRow.date;
        const label=days===7||index===0||index===summary.rows.length-1||active;
        return <button key={row.date} type="button" data-day={row.date} className={`daily-bar ${active?'selected':''} ${row.keys?'has-keys':''}`} aria-pressed={active} tabIndex={active?0:-1} disabled={row.date<'1970-01-01'}
          aria-label={`${row.date}、${fmt(row.keys)}打鍵、入力${activityTime(row.activeMs)}、${fmt(row.phrases)}語${row.estimated?'、概算を含む':''}`}
          title={`${dayLabel(row.date)} · ${fmt(row.keys)}打鍵`} onClick={()=>selectDay(row.date)} onKeyDown={event=>moveSelection(event,row)}>
          <span className="daily-bar-track" aria-hidden="true"><span className="daily-bar-fill" style={{height:`${row.keys/maxKeys*100}%`}}><i className="daily-practice" style={{flexGrow:row.practice.keys}}/><i className="daily-capture" style={{flexGrow:row.capture.keys}}/></span></span>
          <span className={`daily-bar-label ${label?'':'is-empty'}`} aria-hidden="true">{label?days===7?new Intl.DateTimeFormat('ja-JP',{weekday:'short',timeZone:'Asia/Tokyo'}).format(new Date(`${row.date}T12:00:00+09:00`)):shortDay(row.date):'·'}</span>
        </button>;
      })}
    </div>
    <div className="daily-total" aria-label={`${days}日間の合計`}><span>期間の合計{summary.totals.estimated&&<small>（概算を含む）</small>}</span><strong>{activityTime(summary.totals.activeMs)}</strong><span>·</span><strong>{fmt(summary.totals.keys)}<small>打鍵</small></strong><span>·</span><strong>{fmt(summary.totals.phrases)}<small>語</small></strong></div>
    <div className="daily-selection">
      <div className="daily-date-control"><button type="button" className="icon-button" aria-label="前の日" disabled={selectedRow.date<='1970-01-01'} onClick={()=>selectDay(shiftDay(selectedRow.date,-1))}><ArrowLeft size={15}/></button><label><CalendarDays size={15}/><input type="date" aria-label="練習量を表示する日" value={selectedRow.date} min="1970-01-01" max={today} onChange={event=>selectDay(event.target.value)}/></label><button type="button" className="icon-button" aria-label="次の日" disabled={selectedRow.date>=today} onClick={()=>selectDay(shiftDay(selectedRow.date,1))}><ArrowRight size={15}/></button></div>
      {selectedRow.date===today?<span className="daily-today">今日</span>:<button type="button" className="text-button" onClick={goToday}>今日へ戻る</button>}
    </div>
    <div className="daily-metrics" aria-live="polite" aria-atomic="true">
      <div><span><Clock3 size={14}/>入力時間</span><strong data-testid="daily-time">{activityTime(selectedRow.activeMs)}</strong></div>
      <div><span><Keyboard size={14}/>打鍵数</span><strong data-testid="daily-keys">{fmt(selectedRow.keys)}<small>打鍵</small></strong></div>
      <div><span><Layers size={14}/>延べ語数</span><strong data-testid="daily-phrases">{fmt(selectedRow.phrases)}<small>語</small></strong></div>
    </div>
    {hasActivity?<table className="daily-breakdown"><caption className="sr-only">{selectedRow.date}の練習量の内訳</caption><thead><tr><th scope="col">内訳</th><th scope="col">入力時間</th><th scope="col">打鍵</th><th scope="col">語数</th></tr></thead><tbody>{([{key:'capture',name:'寿司打',unit:'記録'},{key:'practice',name:'UCHIKOMI 復習',unit:'セット'}] as const).map(item=>{
      const value=selectedRow[item.key];return <tr key={item.key}><th scope="row"><span><i className={`daily-${item.key}`}/>{item.name}</span><small>{fmt(value.records)}{item.unit}</small></th><td>{activityTime(value.activeMs)}</td><td>{fmt(value.keys)}</td><td>{fmt(value.phrases)}</td></tr>;
    })}</tbody></table>:<p className="daily-empty">{selectedRow.date===today?'今日はまだ記録がありません。寿司打や復習を始めると、自動で残ります。':'この日の練習記録はありません。'}</p>}
    <footer className="daily-note"><p>新しい記録の入力時間は、5秒以内の打鍵間隔を合計します。一時停止中は含めません。語数には同じ語句の繰り返しを含みます。</p>{summary.totals.estimated&&<p>旧記録の時間は、保存済みの入力履歴から求めた概算です。</p>}{selectedRow.estimated&&<span className="daily-estimated" data-testid="daily-estimated">この日は旧記録の概算を含みます</span>}</footer>
  </section>;
}
