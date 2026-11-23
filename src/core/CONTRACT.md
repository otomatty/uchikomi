# Shared APIs
All times are epoch milliseconds; intervals are ms. `Session.score` is the total yen eaten. `Session.scoreType`, `Settings.scoreType`, and `ScoreReview.scoreType` retain the compatibility field with the sole value `'total'`; there is no selectable score unit. No demo data is persisted by default.

core/db.ts exports:
- getData():Promise<AppData>
- getSettings():Promise<Settings> (preferences-only read; canvas discovery never loads image/history stores)
- savePhrase(phrase:Phrase):Promise<Phrase> (upsert/dedupe by text + reading/roman; returns canonical ID)
- updatePhrase(id:string, patch:Partial<Phrase>):Promise<Phrase> (returns the canonical phrase after editing/consolidation, so immediate practice uses its current ID)
- deletePhrase(id:string):Promise<void> (cascade attempts)
- saveAttempt(attempt:Attempt):Promise<void>
- saveSession(session:Session):Promise<void>
- saveAutomaticScore(sessionId:string, patch:AutomaticScore):Promise<boolean> — atomically stores an OCR result and clears scoreReview; returns false for a duplicate, older/weaker OCR result, or any existing manual/legacy score. Patch requires score, scoreType:'total', scoreConfidence (0..100), scoreObservedAt; optional scoreEvidence data URL, scoreTotal, scoreModeSource. If provided, scoreTotal must equal score. Ordinary save APIs reject legacy score units rather than interpreting them as totals.
- updateSettings(patch:Partial<Settings>):Promise<Settings>
- importData(value:unknown):Promise<void> converts legacy monetary fields and validates before mutation; merges IDs atomically
- exportData():Promise<AppData & {version:1;exportedAt:number}> validates format/count limits and standalone references before returning a complete, restorable snapshot; does not omit images or records
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
UCHI_START -> {ok:true,status} or {ok:false,error}; explicit manual tabCapture fallback for the active Sushi-da tab, subject to Chrome's user-invocation requirement.
UCHI_STOP -> {ok:true,status,sessionId?}; persists autoRecord:false, stops media and saves queued records. Does not restart on navigation/visibility changes.
UCHI_RESUME -> {ok:true,status}; persists autoRecord:true and probes permitted game tabs. A visible canvas starts itself; no tabCapture permission is requested.
UCHI_FRAME -> {ok:true,frame:FrameSnapshot} (snapshot for calibration, recording active)
UCHI_CALIBRATE {calibration} -> {ok:true}
UCHI_OPEN_GAME -> {ok:true} activates/opens official https://sushida.net/play.html
UCHI_STATE broadcast {status} to UI.
UI uses db directly for CRUD; service worker/offscreen same origin IndexedDB. Agent may introduce private capture message names freely.

## Automatic visible-canvas recording

`Settings.autoRecord:boolean` defaults to true; backups and stored preferences without it use that default. A user pause is persistent and resume is explicit. Merely hiding/closing/navigating away from the game stops the current capture without changing the preference. No game Session is created until the first detected prompt; reopening a visible game starts a fresh capture rather than extending a partially observed typing interval.

The permitted content script selects the largest visible game canvas and uses the standard origin-clean `captureStream(15)` API. Where available, `MediaStreamTrackProcessor` consumes actual source `VideoFrame` objects with a one-frame queue. Each frame is closed before waiting for its JPEG acknowledgement. Source timestamps reject repeats. A detached muted video with `requestVideoFrameCallback` is the compatibility fallback and is sampled at most once per 80 ms. Both paths keep one outstanding JPEG message, cap the image at 1920×1440, and report an error if the first frame is not acknowledged within ten seconds. It neither changes the WebGL context nor reads game internals. The game video/audio is not forwarded through tabCapture in the default path. Tainted/muted/ended streams fail closed and need a new visibility event or an explicit retry. Hidden documents do not submit frames or observe keys.

`UCHI_CANVAS_READY {documentToken}` returns `{ok:true,sessionId? ,paused?,busy?}`. The background binds the session to sender tab/frame/document IDs and the per-document token. `UCHI_CANVAS_FRAME {sessionId,documentToken,frame:{dataUrl,width,height,at,sequence}}` is forwarded as `UCHI_OFF_CANVAS_FRAME`; `{ok:true,dropped:true}` acknowledges stale/concurrent frames without reprocessing them. `UCHI_CANVAS_END {sessionId,documentToken,reason}` stops that owner only. Keys, focus gaps and view changes carry the same ownership identity. `UCHI_CANVAS_PROBE` permits rediscovery; `UCHI_CAPTURE_DISABLE` stops the producer and flushes keys. Manual fallback observers retain their key subscription when the tab is temporarily hidden, while excluding hidden/out-of-focus input.

`CaptureStatus.source?:'canvas'|'tab'` describes the active path. Optional `frameId`, `documentId` and `documentToken` belong to the background's owner record; offscreen status updates cannot replace them or revive an old capture. Startup cancellation waits for its transition before draining/closing the offscreen document. Late frames, decoded images and worker notifications cannot attach to a newer session. More than 300 ms without a frame breaks the typing boundary. A repeated or stopped image cannot serve as another independent result-score observation.

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

Optional Session fields: `captureId`, `scoreSource:'ocr'|'manual'`, `scoreConfidence`, `scoreObservedAt`, `scoreEvidence`, `scoreTotal`, and `scoreReview:{score?,scoreType:'total',confidence,observedAt,evidence?,reason}`. `scoreTotal` is a compatibility alias for `score`, not another score metric; when both are present they must agree. New saved records and exports contain no `scoreProfit`. A review candidate does not populate `score`, so graphs and best scores ignore it. Each game can have its own Session linked to the recording by `captureId`.

`scoreModeSource?:'configured'|'ocr'` records how accuracy mode was established: the user's explicitly configured course/mode, or a recognized result heading. `saveAutomaticScore` accepts the same optional field. This provenance is preserved in backups and asynchronous session writes; it does not claim that an unreadable heading was recognized. Editing only the numeric score does not change the recorded origin of its mode.

`saveSession` preserves an existing manual score (including legacy scores without a source) against asynchronous capture writes. It also preserves a saved OCR result when an older capture object has no score. Explicit user corrections must set `scoreSource:'manual'`; this clears OCR confidence/evidence/review and replaces the `scoreTotal` alias with the edited score. `saveAutomaticScore` performs its score/source checks inside the same IndexedDB transaction as the write. Summary statistics only include confirmed total scores from the configured 10,000 yen accuracy course.

CaptureStatus adds `activeSessionId`, `latestScore:{sessionId,score,scoreType,confidence?}`, `scoreState:'watching'|'reading'|'saved'|'review'`, and `scoreReviewSessionId`. Its original `sessionId` remains the recording's content-key routing ID.

## Total-score migration and backup compatibility

The database name remains `uchikomi-v1`; its current IndexedDB schema version is **3**. The total-score conversion was introduced in schema 2 and still runs only for databases older than schema 2. Opening a version 1 database converts sessions and stored settings in the single versionchange transaction, together with the phrase consolidation below. Object stores and indexes are created only if absent. Connections close on `versionchange`; a blocked open reports the need to close the other UCHIKOMI page. If migration validation fails, the upgrade aborts and the old database remains intact. Reopening a version 2 or 3 database does not run the monetary conversion again.

Backup format remains `version:1`. Legacy import and the database upgrade use the same conversion: a legacy `scoreType:'profit'` amount becomes `score + course` (the supported course is 10,000 yen); an existing total amount stays unchanged. Pending review candidates follow their own recorded score type. Legacy `scoreProfit` is removed after its corresponding total is checked. Canonical exports contain total-only fields, and reimporting them does not add the course price again. Settings change only their score type: the numeric target, baseline, target date, and all other supported settings are preserved. The defaults remain a 30,000 yen target and an 18,000 yen baseline.

When legacy monetary fields imply different totals, migration does not choose one. It removes the confirmed score and its total alias, and stores a pending review with no prefilled score. Its reason retains every conflicting total plus the converted candidate and reason from any earlier review. Existing review confidence, timestamps, and evidence are retained; the session's separate evidence also remains available. These records stay out of graphs until the user confirms the total. New ordinary writes accept only canonical total values; legacy conversion is confined to upgrade and import.

## Duplicate keywords and accumulated history

Schema 3 consolidates existing duplicate phrases in the versionchange transaction and creates `phraseAliases` (key `id`, index `phraseId`). The same grouping applies when saving, editing or importing phrases. Text is compared after NFKC and whitespace removal; known readings are additionally normalized from katakana to hiragana and must match. Different text, different known readings and approximate OCR matches are not merged. A missing-reading row can join a matching roman spelling only when exactly one known-reading group exists for that text; if there are two known readings, even a single roman match remains separate. Missing readings never connect two different readings.

Existing canonical IDs remain stable when new captures or old backups arrive; otherwise the oldest saved phrase supplies the ID. Verified, complete spelling takes precedence over unverified OCR. Merges retain the earliest/latest observation dates and unique tags. `Phrase.seenSources?:{id:string;count:number}[]` records each original ID's count; repeated snapshots of the same source use its maximum rather than adding again. The sum equals `seenCount`, so importing an old duplicate or the same backup repeatedly does not increase the total. `Phrase.screenshots?:string[]` retains original image evidence from consolidated saved rows/imports. Ordinary repeated captures update the representative `screenshot` without appending a new archived image on every appearance.

Attempts retain their IDs, physical keystrokes, timings and session links; `phraseId` moves to the canonical keyword. Aliases also route delayed attempts from an already-merged ID. Only measurements compatible with the canonical input graph retain `reliable:true`; incompatible records remain inspectable. Session counters and scores are not reduced by consolidation. Word/pattern analytics recompute from the linked eligible history using their existing observation windows; rates are never obtained by summing percentages.

The merged row is validated before writing. A count, tag, image or provenance limit failure aborts the entire transaction instead of dropping records or storing an unexportable aggregate. Export format remains version 1, with the new fields optional; aliases are reconstructed from `seenSources` during import. `clearData()` also clears alias records.

## Daily training volume

`Session.activity?:DailyActivity[]` adds measured daily totals without changing schema 3 or backup version 1. Each entry is `{date:'YYYY-MM-DD',activeMs:number,keys:number,phrases:number}` in Japan Standard Time (`Asia/Tokyo`, UTC+09:00). An absent array marks a legacy record; an empty array marks a newly measured session with no activity. This distinction survives backup/import and prevents attempts from being counted again over a measured session.

`core/activity.ts` exports `TrainingActivity`, `trainingDateKey(at)`, `mergeDailyActivity(before,after)` and `dailyTraining(data,{today?,days?})`, plus the `DailyTrainingRow`, `DailyTrainingTotals` and `DailyTrainingSummary` interfaces. `today` is the requested end date, including historical windows; `days` defaults to 30. Rows are chronological and include zero-activity dates. A summary contains `{timeZone,from,to,rows,today,totals,activeDays}`. Each row has `{date,activeMs,keys,phrases,captureCount,practiceCount,estimated,capture,practice}`; source subtotals are `{activeMs,keys,phrases,records,estimated}`. Summary totals omit only the date. Active days have a positive measured or estimated time, key count or phrase count.

`TrainingActivity.recordKey(at)` counts observed typing keys, including misses. Input time is the sum of consecutive positive key intervals at most 5,000 ms long; longer gaps contribute zero time. The first key contributes no time. Equal-timestamp keys each count but add no time. `break()` ends the timing chain for pause, hidden or lost-focus periods. Invalid clocks contribute no invented date, and reversed clocks end the chain before subsequent timing resumes. Intervals crossing JST midnight are split at midnight; each key belongs to its own timestamp's date. `recordPhrase(uniqueOccurrenceId,at)` counts a particular appearance once, independent of later OCR retries or canonical keyword merging. `snapshot()` returns a detached, sorted copy and never adds idle time.

Daily volume includes incomplete or analytically unreliable observed training; it is not a speed/accuracy ranking. Only capture and practice sources contribute. A measured session uses its activity exclusively, including an empty array. Its recording/set count belongs to its first nonempty activity date, so crossing midnight does not add another record. These counters mean Sushi-da recording records and practice sets, not independently verified game rounds. Sessions and attempts are deduplicated by ID before aggregation.

Legacy sessions are marked `estimated`. If attempts exist, their recorded duration and input counts take precedence over the parent session's elapsed window and counters; they are never added together. Stored attempt durations are apportioned across their start/end dates, while existing judgement timestamps place known keys on their observed days. Keys without timestamps and phrase occurrences fall back to the attempt's start day. Only sessions without attempt history use stored session duration/counters as estimates. Missing amounts are not manufactured, and empty records do not become activity. The new five-second/pause exclusion is not retroactively asserted for legacy elapsed durations. A temporarily orphaned stored attempt can still contribute its known practice under its session ID.

Saving or importing a repeated session merges activity by date, taking each counter's maximum. A stale snapshot, score correction, OCR result, empty array or legacy backup cannot erase measured work. The combined result is validated inside the same write transaction. Dates must be real and unique; key/phrase counts must be nonnegative integers. A session supports at most 366 activity dates, 86,400,000 total input milliseconds, 20,000,000 typing keys and 1,000,000 phrase appearances. A malformed or overflowing merge aborts the entire write/import, preserving the existing records and settings.
