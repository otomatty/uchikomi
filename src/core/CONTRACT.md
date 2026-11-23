# Shared APIs
All times are epoch milliseconds; intervals are ms. Scores are numeric recorded values with scoreType, never combine profit and total. No demo data persisted by default.

core/db.ts exports:
- getData():Promise<AppData>
- savePhrase(phrase:Phrase):Promise<Phrase> (upsert/dedupe by text + reading/roman; returns canonical ID)
- updatePhrase(id:string, patch:Partial<Phrase>):Promise<void>
- deletePhrase(id:string):Promise<void> (cascade attempts)
- saveAttempt(attempt:Attempt):Promise<void>
- saveSession(session:Session):Promise<void>
- updateSettings(patch:Partial<Settings>):Promise<Settings>
- importData(value:unknown):Promise<void> validates before mutation; merges IDs
- exportData():Promise<AppData & {version:1;exportedAt:number}>
- clearData():Promise<void>
- subscribe(onChange:()=>void):()=>void (BroadcastChannel + same-page callbacks)

core/analytics.ts exports:
- analyzePatterns(attempts:Attempt[], phrases?:Phrase[]):PatternStat[] (only reliable + not demo unless all demo)
- choosePractice(phrases:Phrase[], attempts:Attempt[], count:number, pattern?:string):Phrase[] (verified/captured eligible, exclude unverified unless UI selected)
- summarize(data:AppData): {best:number|null;median:number|null;delta:number|null;accuracy:number|null;kps:number|null;practiceCount:number;streak:number;todayCount:number}
- buildAttempt({phrase,strokes,startedAt,endedAt,sessionId,source,complete,reliable}):Attempt

core/romaji.ts exports:
- normalizeRoman(s:string):string
- createMatcher(reading:string, fallbackRoman:string): {feed(key:string):{accepted:boolean;complete:boolean;position:number;display:string}; reset():void; readonly typed:string; readonly display:string; readonly complete:boolean; readonly position:number}
- kanaToRoman(kana:string):string

UI <=> extension runtime messages all names prefixed UCHI_:
UCHI_STATUS -> {ok:true,status:CaptureStatus}
UCHI_START -> {ok:true,status} or {ok:false,error}; invoked directly by UI button. Agent handles active/last known sushida tab.
UCHI_STOP -> {ok:true,status,sessionId?}
UCHI_FRAME -> {ok:true,frame:FrameSnapshot} (snapshot for calibration, recording active)
UCHI_CALIBRATE {calibration} -> {ok:true}
UCHI_OPEN_GAME -> {ok:true} activates/opens official https://sushida.net/play.html
UCHI_STATE broadcast {status} to UI.
UI uses db directly for CRUD; service worker/offscreen same origin IndexedDB. Agent may introduce private capture message names freely.
