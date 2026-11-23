export type Source = 'capture' | 'practice' | 'manual' | 'demo';
export interface KeyStroke { key: string; code?: string; at: number; repeat?: boolean; }
export interface StrokeSample { pattern: string; intervalMs: number; error: boolean; at: number; }
export interface Phrase {
 id: string; text: string; reading: string; roman: string; source: Source;
 confidence: number; verified: boolean; capturedAt: number; lastSeenAt: number; seenCount: number;
 screenshot?: string; tags?: string[];
}
export interface Attempt {
 id: string; phraseId: string; sessionId: string; source: Source; startedAt: number; endedAt: number;
 durationMs: number; correctKeys: number; mistakes: number; accuracy: number; kps: number;
 samples: StrokeSample[]; complete: boolean; reliable: boolean; typed: string;
}
export interface Session {
 id: string; startedAt: number; endedAt?: number; source: 'capture'|'practice'|'manual'|'demo';
 score?: number; scoreType: 'profit'|'total'; course: 10000; mode: 'accuracy';
 phraseCount: number; correctKeys: number; mistakes: number; durationMs: number;
}
export interface Rect { x:number; y:number; width:number; height:number; }
export interface Calibration { japanese:Rect; reading?:Rect; roman:Rect; viewport?:{width:number;height:number}; updatedAt:number; }
export interface Settings {
 targetScore:number; baselineScore:number; targetDate:string; scoreType:'profit'|'total';
 sessionLength:number; includeUnverified:boolean; calibration?:Calibration;
}
export interface PatternStat {
 pattern:string; count:number; errors:number; errorRate:number; medianMs:number; p90Ms:number;
 previousMedianMs:number|null; improvement:number|null; priority:number; phraseIds:string[]; confidence:'low'|'medium'|'high';
}
export interface CaptureStatus {
 state:'idle'|'starting'|'recording'|'stopping'|'error'; sessionId?:string; tabId?:number; startedAt?:number;
 phraseCount:number; message?:string; ocrReady?:boolean; latestPhrase?:string; lastFrameAt?:number;
 regionState?:'searching'|'locked'|'manual'; regionConfidence?:number; region?:Rect;
}
export interface AppData { phrases:Phrase[]; attempts:Attempt[]; sessions:Session[]; settings:Settings; }
export interface FrameSnapshot { dataUrl:string; width:number; height:number; at:number; }
export const DEFAULT_SETTINGS:Settings={targetScore:30000,baselineScore:18000,targetDate:'2026-12-25',scoreType:'profit',sessionLength:10,includeUnverified:false};
export const EMPTY_CAPTURE:CaptureStatus={state:'idle',phraseCount:0};
