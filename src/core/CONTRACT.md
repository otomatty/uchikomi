# Shared APIs
All times are epoch milliseconds; intervals are ms. Scores are numeric recorded values with scoreType, never combine profit and total. No demo data persisted by default.

core/db.ts exports:
- getData():Promise<AppData>
- savePhrase(phrase:Phrase):Promise<Phrase> (upsert/dedupe by text + reading/roman; returns canonical ID)
- updatePhrase(id:string, patch:Partial<Phrase>):Promise<void>
- deletePhrase(id:string):Promise<void> (cascade attempts)
- saveAttempt(attempt:Attempt):Promise<void>
- saveSession(session:Session):Promise<void>
- saveAutomaticScore(sessionId:string, patch:AutomaticScore):Promise<boolean> — atomically stores an OCR result and clears scoreReview; returns false for a duplicate, older/weaker OCR result, or any existing manual/legacy score. Patch requires score, scoreType, scoreConfidence (0..100), scoreObservedAt; optional scoreEvidence data URL, scoreTotal, scoreProfit. Total minus profit must equal the 10,000 yen course price.
- updateSettings(patch:Partial<Settings>):Promise<Settings>
- importData(value:unknown):Promise<void> validates before mutation; merges IDs
- exportData():Promise<AppData & {version:1;exportedAt:number}>
- clearData():Promise<void>
- subscribe(onChange:()=>void):()=>void (BroadcastChannel + same-page callbacks)

core/analytics.ts exports:
- analyzePatterns(attempts:Attempt[], phrases?:Phrase[]):PatternStat[] (only reliable + not demo unless all demo)
- typingBaseline(attempts:Attempt[], phrases?:Phrase[]):{meanMs:number|null;kps:number|null;count:number}
- analyzeWords(attempts:Attempt[], phrases?:Phrase[]):WordStat[] (reliable complete records or explicitly validated terminal-miss captures; most mistakes first; up to the latest 50 attempts per word)
- analyzeConfusions(attempts:Attempt[], phraseId?:string):KeyConfusion[] (actual key, valid expected alternatives, error count; old records without judgements do not produce invented confusion pairs)
- choosePractice(phrases:Phrase[], attempts:Attempt[], count:number, pattern?:string):Phrase[] (verified/captured eligible, exclude unverified unless UI selected)
- summarize(data:AppData): {best:number|null;median:number|null;delta:number|null;accuracy:number|null;kps:number|null;practiceCount:number;streak:number;todayCount:number}
- buildAttempt({phrase,strokes,startedAt,endedAt,sessionId,source,complete,reliable,endOnMistake?}):Attempt
- isErrorTerminatedAttempt(attempt:Attempt):boolean (checks explicit terminal-miss evidence; does not establish capture-boundary reliability)

core/romaji.ts exports:
- normalizeRoman(s:string):string
- createMatcher(reading:string, fallbackRoman:string): {feed(key:string):{accepted:boolean;complete:boolean;position:number;display:string}; reset():void; readonly typed:string; readonly display:string; readonly complete:boolean; readonly position:number; readonly expectedKeys:string[]}
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

## Detailed keys and personal speed

New attempts include optional `judgements:KeyJudgement[]`. Each item contains `actual`, `expected:string[]`, `accepted`, `position` (zero-based accepted-key offset before this event), and epoch `at`. Optional `intervalMs` is the interval since the preceding accepted key when within 15..2000 ms; `pattern` is that key plus the accepted key or preferred expected key. Expected alternatives are taken from the matcher before feeding the key; its currently displayed spelling comes first. Actual mistakes, including an accidental space, remain in the record. Backups without this new array remain valid and are not backfilled with guessed events.

These are local-matcher judgements, not an internal API from the game. An ordinary incomplete or unreliable capture keeps its details for inspection but never contributes to the aggregate confusion, word, or pattern rankings. The sole incomplete-record exception is the explicitly bounded accuracy-mode terminal miss below. A word edit invalidates old attempt reliability as before.

`typingBaseline` is the arithmetic mean of the latest 1,000 reliable, error-free **bigram** intervals in 15..2000 ms, from complete attempts or the clean prefix of a validated terminal-miss capture. First-key response time, pauses and correction intervals are excluded. Trigram observations do not count the same intervals again. `kps` is 1000 / meanMs, not the entire-game official average.

Pattern and word statistics add `meanMs`, `timedCount`, `baselineMs`, `baselineCount`, signed `slowdownPct`, `lostMs` and `slow`. A positive slowdown is the **increase in input interval** relative to the baseline, not the percentage decline in keys per second. `lostMs` is only the summed excess over that reference, not a predicted score gain. A pattern is flagged slow after at least 5 clean samples, at least 20 baseline samples, and a difference of both 20% and 20 ms. A whole word additionally needs at least 3 attempts. Smaller samples still show measured values but are not flagged. `WordStat.slowPatterns` is a string array; `WordStat.confusions` contains actual and expected key pairs with counts.

### Accuracy-mode terminal misses

`AttemptInput.endOnMistake?:boolean` is effective only for `source:'capture'`. When enabled, replay stops immediately after the first rejected physical key. Later keys in the candidate buffer cannot be attributed to that old phrase. `endedAt` and `durationMs` end at that rejection, and `complete` remains false. The attempt receives optional `errorTerminated:true`. Practice keeps its existing correction-and-continue behavior even if the capture-only option is mistakenly passed.

The caller must independently verify that this capture starts at the phrase boundary; `endOnMistake` never overrides `input.reliable:false`. First/reacquired or potentially missing-prefix observations must remain unreliable. A reliable terminal-miss attempt participates in word/confusion counts and in clean pre-error timing. A final error interval is added to 2/3-gram error counts only when exactly one next key is valid and the interval is within 15..2000 ms. Multiple expected alternatives remain in the confusion record without guessing an intended pattern. Error intervals never enter clean speed statistics.

`isErrorTerminatedAttempt` and backup validation require capture source, incomplete status, exactly one final rejected judgement, accepted prefix judgements, consistent positions/counts/typed prefix, ordered timestamps ending at `endedAt`, matching duration, and sample timestamps bounded by that end. A flag with missing or contradictory detail is rejected on save/import and cannot promote a partial record into analytics. Backups without this optional field remain version 1 compatible; no terminal boundary is invented for older records.

## Automatic and reviewed scores

Optional Session fields: `captureId`, `scoreSource:'ocr'|'manual'`, `scoreConfidence`, `scoreObservedAt`, `scoreEvidence`, `scoreTotal`, `scoreProfit`, and `scoreReview:{score?,scoreType,confidence,observedAt,evidence?,reason}`. A review candidate does not populate `score`, so graphs and best scores ignore it. Each game can have its own Session linked to the recording by `captureId`.

`scoreModeSource?:'configured'|'ocr'` records how accuracy mode was established: the user's explicitly configured course/mode, or a recognized result heading. `saveAutomaticScore` accepts the same optional field. This provenance is preserved in backups and asynchronous session writes; it does not claim that an unreadable heading was recognized. Editing only the numeric score does not change the recorded origin of its mode.

`saveSession` preserves an existing manual score (including legacy scores without a source) against asynchronous capture writes. It also preserves a saved OCR result when an older capture object has no score. Explicit user corrections must set `scoreSource:'manual'`; this clears OCR confidence/evidence/review and recomputes total/profit. `saveAutomaticScore` performs its score/source checks inside the same IndexedDB transaction as the write.

CaptureStatus adds `activeSessionId`, `latestScore:{sessionId,score,scoreType,confidence?}`, `scoreState:'watching'|'reading'|'saved'|'review'`, and `scoreReviewSessionId`. Its original `sessionId` remains the recording's content-key routing ID.
