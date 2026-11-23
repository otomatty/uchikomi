import type { AppData, Attempt, DailyActivity, Session } from './types';

const DAY_MS=86400000,JST_MS=9*3600000;
export const MAX_ACTIVITY_DAYS=366;
export const MAX_ACTIVITY_MS=DAY_MS;
export const MAX_ACTIVITY_KEYS=20000000;
export const MAX_ACTIVITY_PHRASES=1000000;

export function validTrainingDate(value:unknown):value is string {
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
}
export function trainingDateKey(at:number):string {
  if(!Number.isFinite(at))throw new RangeError('練習日時を確認してください。');
  const value=new Date(at+JST_MS);
  if(!Number.isFinite(value.getTime()))throw new RangeError('練習日時を確認してください。');
  const date=value.toISOString().slice(0,10);
  if(!validTrainingDate(date))throw new RangeError('練習日時を確認してください。');
  return date;
}
const startOfDate=(date:string)=>Date.parse(`${date}T00:00:00+09:00`);
const tryDate=(at:number)=>{if(at<0)return undefined;try{return trainingDateKey(at);}catch{return undefined;}};

/** Only actual consecutive key intervals contribute time; waiting is not time. */
export class TrainingActivity {
  private rows=new Map<string,DailyActivity>();
  private phrases=new Set<string>();
  private lastKey:number|null=null;
  private row(date:string):DailyActivity {
    let value=this.rows.get(date);
    if(!value){value={date,activeMs:0,keys:0,phrases:0};this.rows.set(date,value);}
    return value;
  }
  recordKey(at:number):void {
    const date=tryDate(at);
    if(!date){this.break();return;}
    this.row(date).keys++;
    if(this.lastKey!==null){
      const gap=at-this.lastKey;
      if(gap<0){this.break();return;}
      if(gap>0&&gap<=5000){
        let cursor=this.lastKey;
        while(cursor<at){
          const day=trainingDateKey(cursor),end=Math.min(at,startOfDate(day)+DAY_MS);
          this.row(day).activeMs+=end-cursor;cursor=end;
        }
      }
    }
    this.lastKey=at;
  }
  recordPhrase(id:string,at:number):void {
    const date=tryDate(at);
    if(!date||!id||this.phrases.has(id))return;
    this.phrases.add(id);this.row(date).phrases++;
  }
  break():void {this.lastKey=null;}
  snapshot():DailyActivity[] {return [...this.rows.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(row=>({...row}));}
}

/** Snapshots are cumulative per session. Missing/older snapshots cannot erase work. */
export function mergeDailyActivity(before:readonly DailyActivity[]|undefined,after:readonly DailyActivity[]|undefined):DailyActivity[]|undefined {
  if(before===undefined&&after===undefined)return undefined;
  const rows=new Map<string,DailyActivity>();
  for(const row of [...before??[],...after??[]]){
    const previous=rows.get(row.date);
    rows.set(row.date,previous?{date:row.date,activeMs:Math.max(previous.activeMs,row.activeMs),keys:Math.max(previous.keys,row.keys),phrases:Math.max(previous.phrases,row.phrases)}:{...row});
  }
  return [...rows.values()].sort((a,b)=>a.date.localeCompare(b.date));
}

export interface DailyTrainingSourceTotals {activeMs:number;keys:number;phrases:number;records:number;estimated:boolean;}
export interface DailyTrainingTotals {
  activeMs:number;keys:number;phrases:number;captureCount:number;practiceCount:number;estimated:boolean;
  capture:DailyTrainingSourceTotals;practice:DailyTrainingSourceTotals;
}
export interface DailyTrainingRow extends DailyTrainingTotals {date:string;}
export interface DailyTrainingSummary {
  timeZone:'Asia/Tokyo';from:string;to:string;rows:DailyTrainingRow[];today:DailyTrainingRow;totals:DailyTrainingTotals;activeDays:number;
}
const emptySource=():DailyTrainingSourceTotals=>({activeMs:0,keys:0,phrases:0,records:0,estimated:false});
const emptyTotals=():DailyTrainingTotals=>({activeMs:0,keys:0,phrases:0,captureCount:0,practiceCount:0,estimated:false,capture:emptySource(),practice:emptySource()});
const trainingSource=(source:string):source is 'capture'|'practice'=>source==='capture'||source==='practice';
const positive=(value:number)=>Number.isFinite(value)&&value>0?value:0;
const hasActivity=(value:Pick<DailyActivity,'activeMs'|'keys'|'phrases'>)=>value.activeMs>0||value.keys>0||value.phrases>0;

/** Daily volume includes incomplete/unreliable training, unlike speed analytics. */
export function dailyTraining(data:AppData,options:{today?:string;days?:number}={}):DailyTrainingSummary {
  const today=options.today??trainingDateKey(Date.now()),days=options.days??30;
  if(!validTrainingDate(today)||!Number.isInteger(days)||days<1||days>3660)throw new RangeError('表示する練習期間を確認してください。');
  const to=startOfDate(today),fromAt=to-(days-1)*DAY_MS,until=to+DAY_MS;
  const rows:DailyTrainingRow[]=Array.from({length:days},(_,i)=>({date:trainingDateKey(fromAt+i*DAY_MS),...emptyTotals()}));
  const byDate=new Map(rows.map(row=>[row.date,row]));
  type Kind='capture'|'practice';
  const add=(date:string,kind:Kind,value:Partial<DailyTrainingSourceTotals>)=>{
    const row=byDate.get(date);if(!row)return;
    const source=row[kind];
    for(const key of ['activeMs','keys','phrases','records'] as const)source[key]+=positive(value[key]??0);
    source.estimated=source.estimated||!!value.estimated;
  };
  const addDuration=(kind:Kind,start:number,end:number,duration:number)=>{
    if(!tryDate(start)||!Number.isFinite(end)||end<start||!positive(duration))return;
    if(end===start){add(trainingDateKey(start),kind,{activeMs:duration,estimated:true});return;}
    const span=end-start;
    let cursor=Math.max(start,fromAt),last=Math.min(end,until);
    while(cursor<last){
      const date=trainingDateKey(cursor),next=Math.min(last,startOfDate(date)+DAY_MS);
      add(date,kind,{activeMs:duration*(next-cursor)/span,estimated:true});cursor=next;
    }
  };
  const sessions=new Map<string,Session>();
  for(const session of data.sessions){
    const previous=sessions.get(session.id);
    if(!previous){sessions.set(session.id,session);continue;}
    const latest=(session.endedAt??session.startedAt)>=(previous.endedAt??previous.startedAt)?session:previous;
    const activity=mergeDailyActivity(previous.activity,session.activity);
    sessions.set(session.id,{...latest,startedAt:Math.min(previous.startedAt,session.startedAt),durationMs:Math.max(previous.durationMs,session.durationMs),correctKeys:Math.max(previous.correctKeys,session.correctKeys),mistakes:Math.max(previous.mistakes,session.mistakes),phraseCount:Math.max(previous.phraseCount,session.phraseCount),...(activity===undefined?{}:{activity})});
  }
  const attempts=new Map<string,Attempt>();
  for(const attempt of data.attempts){
    const previous=attempts.get(attempt.id);
    if(!previous||attempt.endedAt>previous.endedAt||(attempt.endedAt===previous.endedAt&&(attempt.judgements?.length??0)>(previous.judgements?.length??0)))attempts.set(attempt.id,attempt);
  }
  const grouped=new Map<string,Attempt[]>();
  for(const attempt of attempts.values()){
    if(!trainingSource(attempt.source))continue;
    const values=grouped.get(attempt.sessionId)??[];values.push(attempt);grouped.set(attempt.sessionId,values);
  }
  const allIds=new Set([...sessions.keys(),...grouped.keys()]);
  for(const id of allIds){
    const session=sessions.get(id),history=(grouped.get(id)??[]).sort((a,b)=>a.startedAt-b.startedAt||a.id.localeCompare(b.id));
    const kind=session?.source??history[0]?.source;
    if(!kind||!trainingSource(kind))continue;
    if(session?.activity!==undefined){
      const measured=mergeDailyActivity(undefined,session.activity)!;
      for(const row of measured)if(hasActivity(row))add(row.date,kind,row);
      const first=measured.find(hasActivity);if(first)add(first.date,kind,{records:1});
      continue;
    }
    const usable=history.filter(attempt=>attempt.source===kind&&tryDate(attempt.startedAt));
    if(usable.length){
      for(const attempt of usable){
        const date=trainingDateKey(attempt.startedAt),keyCount=positive(attempt.correctKeys)+positive(attempt.mistakes);
        addDuration(kind,attempt.startedAt,attempt.endedAt,positive(attempt.durationMs));
        let datedKeys=0;
        for(const judgement of attempt.judgements??[]){const keyDate=tryDate(judgement.at);if(keyDate){add(keyDate,kind,{keys:1,estimated:true});datedKeys++;}}
        add(date,kind,{keys:Math.max(0,keyCount-datedKeys),phrases:1,estimated:true});
      }
      add(trainingDateKey(usable[0].startedAt),kind,{records:1,estimated:true});
    }else if(session&&tryDate(session.startedAt)){
      const value={activeMs:positive(session.durationMs),keys:positive(session.correctKeys)+positive(session.mistakes),phrases:positive(session.phraseCount)};
      if(!hasActivity(value))continue;
      const date=trainingDateKey(session.startedAt);
      addDuration(kind,session.startedAt,session.endedAt??session.startedAt+value.activeMs,value.activeMs);
      add(date,kind,{keys:value.keys,phrases:value.phrases,records:1,estimated:true});
    }
  }
  const totals=emptyTotals();
  for(const row of rows){
    row.activeMs=row.capture.activeMs+row.practice.activeMs;row.keys=row.capture.keys+row.practice.keys;row.phrases=row.capture.phrases+row.practice.phrases;
    row.captureCount=row.capture.records;row.practiceCount=row.practice.records;row.estimated=row.capture.estimated||row.practice.estimated;
    for(const key of ['activeMs','keys','phrases','captureCount','practiceCount'] as const)totals[key]+=row[key];
    totals.estimated=totals.estimated||row.estimated;
    for(const kind of ['capture','practice'] as const){
      for(const key of ['activeMs','keys','phrases','records'] as const)totals[kind][key]+=row[kind][key];
      totals[kind].estimated=totals[kind].estimated||row[kind].estimated;
    }
  }
  return {timeZone:'Asia/Tokyo',from:rows[0].date,to:today,rows,today:rows[rows.length-1],totals,activeDays:rows.filter(hasActivity).length};
}
