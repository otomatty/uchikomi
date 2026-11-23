import type { ReplayShortcut } from './shortcuts';

export type Source = 'capture' | 'practice' | 'manual' | 'demo';
/** Includes the 10,000-yen course price when migrating the largest legacy profit. */
export const MAX_SCORE = 10_010_000;
export interface KeyStroke { key: string; code?: string; at: number; repeat?: boolean; }
export interface StrokeSample { pattern: string; intervalMs: number; error: boolean; at: number; }
/** The expected alternatives are captured before feeding the actual key to the local matcher. */
export interface KeyJudgement {
 actual:string; expected:string[]; accepted:boolean; position:number; at:number; intervalMs?:number; pattern?:string;
}
export interface KeyConfusion { actual:string; expected:string[]; count:number; }
export interface Phrase {
 id: string; text: string; reading: string; roman: string; source: Source;
 confidence: number; verified: boolean; capturedAt: number; lastSeenAt: number; seenCount: number;
 screenshot?: string; tags?: string[];
 /** Original images archived by consolidation, including its representative. */
 screenshots?: string[];
 /** Per-original-ID counts make consolidation and backup replay idempotent. */
 seenSources?: {id:string;count:number}[];
}
export interface Attempt {
 id: string; phraseId: string; sessionId: string; source: Source; startedAt: number; endedAt: number;
 durationMs: number; correctKeys: number; mistakes: number; accuracy: number; kps: number;
 samples: StrokeSample[]; complete: boolean; reliable: boolean; typed: string; judgements?:KeyJudgement[];
 /** Accuracy-mode capture ended on its first rejected key; never implies a complete phrase. */
 errorTerminated?:boolean;
}
export interface ScoreReview { score?:number; scoreType:'total'; confidence:number; observedAt:number; evidence?:string; reason:string; }
export interface DailyActivity { date:string; activeMs:number; keys:number; phrases:number; }
export interface Session {
 id: string; startedAt: number; endedAt?: number; source: 'capture'|'practice'|'manual'|'demo';
 score?: number; scoreType: 'total'; course: 10000; mode: 'accuracy';
 phraseCount: number; correctKeys: number; mistakes: number; durationMs: number;
 captureId?:string; scoreSource?:'ocr'|'manual'; scoreConfidence?:number; scoreObservedAt?:number; scoreEvidence?:string; scoreModeSource?:'configured'|'ocr';
 scoreTotal?:number; scoreReview?:ScoreReview;
 /** Present (including []) for measured activity; absent for legacy records. */
 activity?:DailyActivity[];
}
export interface Rect { x:number; y:number; width:number; height:number; }
export interface Calibration { japanese:Rect; reading?:Rect; roman:Rect; viewport?:{width:number;height:number}; updatedAt:number; }
export interface Settings {
 targetScore:number; baselineScore:number; targetDate:string; scoreType:'total';
 sessionLength:number; includeUnverified:boolean; autoRecord:boolean; replayShortcut:ReplayShortcut; calibration?:Calibration;
}
export interface PatternStat {
 pattern:string; count:number; errors:number; errorRate:number; medianMs:number; p90Ms:number;
 previousMedianMs:number|null; improvement:number|null; priority:number; phraseIds:string[]; confidence:'low'|'medium'|'high';
 meanMs:number|null; timedCount:number; baselineMs:number|null; baselineCount:number; slowdownPct:number|null; lostMs:number; slow:boolean;
}
export interface WordStat {
 phraseId:string; attempts:number; correctKeys:number; mistakes:number; errorRate:number;
 meanMs:number|null; timedCount:number; baselineMs:number|null; baselineCount:number; slowdownPct:number|null; lostMs:number; slow:boolean;
 confusions:KeyConfusion[]; slowPatterns:string[];
}
export interface CaptureStatus {
 state:'idle'|'starting'|'recording'|'stopping'|'error'; sessionId?:string; tabId?:number; startedAt?:number;
 autoRecordPaused?:boolean;
 source?:'canvas'|'tab'; frameId?:number; documentId?:string; documentToken?:string;
 phraseCount:number; message?:string; ocrReady?:boolean; latestPhrase?:string; lastFrameAt?:number;
 regionState?:'searching'|'locked'|'manual'; regionConfidence?:number; region?:Rect;
 activeSessionId?:string; latestScore?:{sessionId:string;score:number;scoreType:'total';confidence?:number};
 scoreState?:'watching'|'reading'|'saved'|'review'; scoreReviewSessionId?:string;
}
export interface AppData { phrases:Phrase[]; attempts:Attempt[]; sessions:Session[]; settings:Settings; }
export interface FrameSnapshot { dataUrl:string; width:number; height:number; at:number; }
export const DEFAULT_SETTINGS:Settings={targetScore:30000,baselineScore:18000,targetDate:'2026-12-25',scoreType:'total',sessionLength:10,includeUnverified:false,autoRecord:true,replayShortcut:'Escape'};
export const EMPTY_CAPTURE:CaptureStatus={state:'idle',phraseCount:0};
