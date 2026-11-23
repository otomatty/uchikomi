import { buildAttempt } from '../core/analytics';
import type { Attempt, KeyStroke, Phrase } from '../core/types';

/** A small one-way handoff, never a linked list of retained frame candidates. */
export interface CompletionBoundary { promise: Promise<number|null>; settle(at:number|null):void; }
export function createCompletionBoundary():CompletionBoundary {
  let settled=false;
  let resolve!:(value:number|null)=>void;
  const promise=new Promise<number|null>(done=>{resolve=done;});
  return {promise,settle(at){
    if(settled)return;
    settled=true;resolve(typeof at==='number'&&Number.isFinite(at)?at:null);
  }};
}

export interface CapturedReplay {
  phrase:Phrase; strokes:KeyStroke[]; observedAt:number; endedAt:number; sessionId:string;
  contiguous:boolean; precedingCompletion:number|null; observationReliable:boolean;
  focusGaps:number[]; accuracyMode:boolean;
}

/**
 * A screen sample is later than the actual change of word. An immediately
 * preceding fully replayed word supplies its final accepted key timestamp,
 * allowing the next replay to recover early keys before the changed frame.
 * Unanchored terminal errors stay untrusted; they may just be a missing prefix.
 */
export function replayCapturedPhrase(input:CapturedReplay):{attempt:Attempt|null;completionAt:number|null;anchored:boolean} {
  const anchor=input.precedingCompletion;
  // Large gaps are not continuous visual transitions. This also prevents a
  // stale boundary from being reused after a menu, lost frame or delayed retry.
  const anchored=input.contiguous&&typeof anchor==='number'&&Number.isFinite(anchor)&&
    anchor<=input.observedAt&&anchor>=input.observedAt-500&&anchor<input.endedAt;
  const startedAt=anchored?anchor!:input.observedAt;
  const strokes=input.strokes.filter(key=>Number.isFinite(key.at)&&
    (anchored?key.at>startedAt:key.at>=startedAt)&&key.at<input.endedAt);
  if(!strokes.length)return{attempt:null,completionAt:null,anchored};
  const ordered=strokes.every((key,index)=>index===0||key.at>=strokes[index-1].at);
  const uninterrupted=!input.focusGaps.some(at=>at>=startedAt&&at<input.endedAt);
  const observationValid=input.observationReliable&&input.phrase.verified&&ordered&&uninterrupted;
  const attempt=buildAttempt({
    phrase:input.phrase,strokes,startedAt,endedAt:input.endedAt,sessionId:input.sessionId,
    source:'capture',complete:true,reliable:observationValid&&input.contiguous,
    endOnMistake:input.accuracyMode,
  });
  if(attempt.errorTerminated&&!anchored)attempt.reliable=false;
  // A complete, clean replay can establish the next end boundary even when its
  // own start was uncertain. A miss, partial OCR/input, or focus gap cannot.
  const completionAt=observationValid&&attempt.complete&&!attempt.errorTerminated&&attempt.mistakes===0
    ?attempt.judgements?.at(-1)?.at??null:null;
  return{attempt,completionAt,anchored};
}
