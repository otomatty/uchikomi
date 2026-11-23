import type { AppData, Attempt, KeyStroke, PatternStat, Phrase, Source, StrokeSample } from './types';
import { createMatcher, normalizeRoman } from './romaji';
const median=(values:number[]):number=>{
  if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b),i=Math.floor(sorted.length/2);return sorted.length%2?sorted[i]:(sorted[i-1]+sorted[i])/2;
};
const percentile=(values:number[],q:number):number=>{
  if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*q)-1)];
};
const id=()=>globalThis.crypto?.randomUUID?.()??`attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export interface AttemptInput {
  phrase:Phrase;strokes:KeyStroke[];startedAt:number;endedAt:number;sessionId:string;source:Source;complete:boolean;reliable:boolean;
}
/** Replays captured physical input against the local accepted-romanization graph. */
export function buildAttempt(input:AttemptInput):Attempt {
  const {phrase,startedAt,endedAt,sessionId,source}=input;
  const matcher=createMatcher(phrase.reading,phrase.roman),samples:StrokeSample[]=[];
  const accepted:{key:string;at:number;error:boolean}[]=[];
  let mistakes=0,pendingError=false,ordered=true,lastTimestamp=startedAt;
  for(const stroke of input.strokes) {
    if(!Number.isFinite(stroke.at)||stroke.at<startedAt||stroke.at>endedAt)continue;
    if(stroke.at<lastTimestamp)ordered=false;lastTimestamp=stroke.at;
    if(stroke.repeat||stroke.key.length!==1||!/[\x20-\x7e]/.test(stroke.key))continue;
    if(matcher.complete)break;
    const result=matcher.feed(stroke.key);
    if(!result.accepted){mistakes++;pendingError=true;continue;}
    accepted.push({key:normalizeRoman(stroke.key),at:stroke.at,error:pendingError});pendingError=false;
    const n=accepted.length;
    if(n>=2) {
      const gap=accepted[n-1].at-accepted[n-2].at;
      // <15 ms commonly signals paste/key rollover; >2 s is a pause, not a finger-transition sample.
      if(gap>=15&&gap<=2000)samples.push({pattern:accepted.slice(-2).map(k=>k.key).join(''),intervalMs:gap,error:accepted[n-1].error,at:stroke.at});
    }
    if(n>=3) {
      const left=accepted[n-2].at-accepted[n-3].at,right=accepted[n-1].at-accepted[n-2].at;
      if(left>=15&&right>=15&&left<=2000&&right<=2000)samples.push({pattern:accepted.slice(-3).map(k=>k.key).join(''),intervalMs:(left+right)/2,error:accepted[n-2].error||accepted[n-1].error,at:stroke.at});
    }
  }
  const durationMs=Math.max(0,endedAt-startedAt),correctKeys=accepted.length,total=correctKeys+mistakes;
  const complete=input.complete&&matcher.complete&&correctKeys>0;
  return {id:id(),phraseId:phrase.id,sessionId,source,startedAt,endedAt:Math.max(startedAt,endedAt),durationMs,correctKeys,mistakes,
    accuracy:total?100*correctKeys/total:0,kps:durationMs?correctKeys/(durationMs/1000):0,samples,complete,
    reliable:input.reliable&&complete&&ordered&&durationMs>0,typed:matcher.typed};
}
export function analyzePatterns(attempts:Attempt[],phrases?:Phrase[]):PatternStat[] {
  const demoOnly=attempts.length>0&&attempts.every(a=>a.source==='demo');
  const known=phrases?new Set(phrases.map(p=>p.id)):null;
  const groups=new Map<string,{sample:StrokeSample;phraseId:string}[]>();
  for(const attempt of attempts) {
    if(!attempt.reliable||!attempt.complete||(!demoOnly&&attempt.source==='demo')||(known&&!known.has(attempt.phraseId)))continue;
    for(const sample of attempt.samples) {
      if(!/^[\x21-\x7e]{2,3}$/.test(sample.pattern)||!Number.isFinite(sample.intervalMs)||sample.intervalMs<15||sample.intervalMs>2000)continue;
      const list=groups.get(sample.pattern)??[];list.push({sample,phraseId:attempt.phraseId});groups.set(sample.pattern,list);
    }
  }
  const overallMedian=median([...groups.values()].flatMap(g=>g.filter(x=>x.sample.pattern.length===2).map(x=>x.sample.intervalMs)))||150;
  const result:PatternStat[]=[];
  for(const [pattern,all] of groups) {
    all.sort((a,b)=>a.sample.at-b.sample.at);
    const recent=all.slice(-60),count=recent.length,errors=recent.filter(x=>x.sample.error).length;
    const windows=count>=10?Math.min(20,Math.floor(count/2)):0;
    const old=windows?recent.slice(-windows*2,-windows).map(x=>x.sample.intervalMs):[];
    const latest=windows?recent.slice(-windows):recent;
    const previousMedianMs=old.length>=5?median(old):null,medianMs=median(latest.map(x=>x.sample.intervalMs));
    const improvement=previousMedianMs?100*(previousMedianMs-medianMs)/previousMedianMs:null;
    // Shrink sparse estimates toward the player's median; a rare typo must not dominate the queue.
    const weight=count/(count+8),shrunkError=(errors+0.35)/(count+7);
    const slowness=Math.max(0,Math.min(2.5,medianMs/overallMedian-1));
    const priority=100*weight*(0.68*shrunkError+0.32*Math.min(1,slowness));
    result.push({pattern,count,errors,errorRate:errors/count*100,medianMs,p90Ms:percentile(recent.map(x=>x.sample.intervalMs),.9),previousMedianMs,improvement,
      priority,phraseIds:[...new Set(recent.map(x=>x.phraseId))],confidence:count<5?'low':count<20?'medium':'high'});
  }
  return result.sort((a,b)=>b.priority-a.priority||b.count-a.count||a.pattern.localeCompare(b.pattern));
}
export function choosePractice(phrases:Phrase[],attempts:Attempt[],count:number,pattern?:string):Phrase[] {
  if(!Number.isFinite(count)||count<=0)return [];
  const demoOnly=phrases.length>0&&phrases.every(p=>p.source==='demo');
  const stats=analyzePatterns(attempts,phrases),patternById=new Map<string,number>();
  for(const stat of stats)for(const phraseId of stat.phraseIds)patternById.set(phraseId,Math.max(patternById.get(phraseId)??0,stat.priority));
  const lastPractice=new Map<string,number>(),practiceCount=new Map<string,number>();
  for(const a of attempts)if(a.source==='practice'||(demoOnly&&a.source==='demo')){lastPractice.set(a.phraseId,Math.max(lastPractice.get(a.phraseId)??0,a.endedAt));practiceCount.set(a.phraseId,(practiceCount.get(a.phraseId)??0)+1);}
  const now=Date.now(),wanted=normalizeRoman(pattern??'');
  const withRequestedSpelling=(phrase:Phrase):Phrase=>{
    if(!wanted||normalizeRoman(phrase.roman).includes(wanted))return phrase;
    const actualSpellings=attempts.filter(a=>a.phraseId===phrase.id&&a.reliable&&a.complete&&(demoOnly||a.source!=='demo')&&normalizeRoman(a.typed).includes(wanted)).sort((a,b)=>b.endedAt-a.endedAt);
    for(const attempt of actualSpellings){
      const roman=normalizeRoman(attempt.typed),matcher=createMatcher(phrase.reading,phrase.roman);
      let accepted=true;
      for(const key of roman)if(!matcher.feed(key).accepted){accepted=false;break;}
      // This is a queue-only preference. The original captured phrase remains unchanged.
      if(accepted&&matcher.complete)return {...phrase,roman};
    }
    return phrase;
  };
  const eligible=phrases.filter(p=>p.verified&&!!p.roman&&(/^[\x21-\x7e]+$/.test(normalizeRoman(p.roman)))&&(demoOnly||p.source!=='demo')).map(withRequestedSpelling).filter(p=>{
    if(!wanted)return true;
    return normalizeRoman(p.roman).includes(wanted)||createMatcher(p.reading,p.roman).display.includes(wanted);
  });
  const score=(p:Phrase)=>{
    const age=lastPractice.has(p.id)?Math.min(7,(now-lastPractice.get(p.id)!)/86400000):7;
    return (patternById.get(p.id)??0)*2+age*3+Math.log1p(p.seenCount)*2- Math.min(8,practiceCount.get(p.id)??0);
  };
  eligible.sort((a,b)=>score(b)-score(a)||a.id.localeCompare(b.id));
  if(!eligible.length)return [];
  const result:Phrase[]=[];
  const total=Math.min(100,Math.floor(count));
  // A small personal corpus can be repeated; never invent unseen vocabulary.
  for(let i=0;i<total;i++)result.push(eligible[i%eligible.length]);
  return result;
}
function dateKey(at:number):string {
  // The training target is in Japan; keep streaks stable when the device timezone differs.
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
}
export function summarize(data:AppData):{best:number|null;median:number|null;delta:number|null;accuracy:number|null;kps:number|null;practiceCount:number;streak:number;todayCount:number} {
  const demoOnly=data.sessions.length>0&&data.sessions.every(s=>s.source==='demo');
  const scored=data.sessions.filter(s=>s.course===10000&&s.mode==='accuracy'&&s.source!=='practice'&&s.scoreType===data.settings.scoreType&&Number.isFinite(s.score)&&(demoOnly||s.source!=='demo')).sort((a,b)=>a.startedAt-b.startedAt);
  const latestMedian=scored.length?median(scored.slice(-5).map(s=>s.score!)):null;
  const usable=data.attempts.filter(a=>a.reliable&&a.complete&&(a.source==='practice'||(demoOnly&&a.source==='demo')));
  const recent=usable.slice().sort((a,b)=>a.endedAt-b.endedAt).slice(-50),keys=recent.reduce((n,a)=>n+a.correctKeys,0),errors=recent.reduce((n,a)=>n+a.mistakes,0),duration=recent.reduce((n,a)=>n+a.durationMs,0);
  const practice=data.attempts.filter(a=>a.complete&&(a.source==='practice'||(demoOnly&&a.source==='demo')));
  const today=dateKey(Date.now()),days=new Set(data.sessions.filter(s=>s.endedAt&&(demoOnly||s.source!=='demo')).map(s=>dateKey(s.startedAt)));
  for(const a of practice)days.add(dateKey(a.startedAt));
  let streak=0,cursor=Date.now();if(!days.has(today))cursor-=86400000;
  while(days.has(dateKey(cursor))){streak++;cursor-=86400000;}
  return {best:scored.length?Math.max(...scored.map(s=>s.score!)):null,median:latestMedian,delta:latestMedian===null?null:latestMedian-data.settings.baselineScore,
    accuracy:keys+errors?100*keys/(keys+errors):null,kps:duration?keys/(duration/1000):null,practiceCount:practice.length,streak,todayCount:practice.filter(a=>dateKey(a.startedAt)===today).length};
}
