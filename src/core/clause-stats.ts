import { typingBaseline, usableAttempts } from './analytics';
import { sameClause, splitClauses } from './clauses';
import { createKanaTrace, hiragana } from './romaji';
import type { Attempt, Clause, Phrase } from './types';

interface Observation { missed:boolean; intervals:number; totalMs:number; }
export interface WeakClause {
  phrase:Phrase; clause:Clause; attempts:number; mistakeAttempts:number;
  slowdownPct:number | null;
}

function indexPhrase(phrase:Phrase) {
  const parts = splitClauses(phrase);
  const byKana: (Clause | undefined)[] = Array(hiragana(phrase.reading).length);
  for (const part of parts) byKana.fill(part, part.start, part.start + part.reading.length);
  const keys = new Map(parts.map(part=>[part,JSON.stringify([part.text,part.reading])]));
  return {parts, keys, byKana, trace:createKanaTrace(phrase.reading)};
}

function measure(attempt:Attempt, source:ReturnType<typeof indexPhrase>) {
  const observations = new Map<string, Observation & {clause:Clause}>();
  const drill = attempt.clause;
  const selected = drill && source.parts.find(part => sameClause(part, drill));
  if (drill && !selected) return observations;
  const {trace, byKana} = source;
  trace.reset();
  let previous:Clause | undefined;
  for (const key of attempt.judgements ?? []) {
    let part = selected;
    if (!drill) {
      const offsets = trace.step(key.actual,key.accepted);
      if (!offsets) { observations.clear(); return observations; }
      part = byKana[offsets[0]];
      if (!offsets.every(offset=>byKana[offset] === part)) part = undefined;
    }
    if (part) {
      const id = source.keys.get(part)!;
      const entry = observations.get(id) ?? {clause:part, missed:false, intervals:0, totalMs:0};
      if (!key.accepted) entry.missed = true;
      if (key.accepted && part === previous && key.intervalMs !== undefined && key.intervalMs >= 15 && key.intervalMs <= 2000) {
        entry.intervals++;
        entry.totalMs += key.intervalMs;
      }
      observations.set(id,entry);
    }
    previous = key.accepted ? part : undefined;
  }
  if (!drill && trace.complete !== attempt.complete) observations.clear();
  return observations;
}

export function analyzeClauses(attempts:Attempt[], phrases:Phrase[]):WeakClause[] {
  const verified = new Map(phrases.filter(phrase=>phrase.verified).map(phrase=>[phrase.id, phrase]));
  const byPhrase = new Map<string,Attempt[]>();
  for (const attempt of usableAttempts(attempts,phrases,true)) {
    if (!verified.has(attempt.phraseId) || !attempt.judgements?.length) continue;
    const list = byPhrase.get(attempt.phraseId) ?? [];
    list.push(attempt);
    byPhrase.set(attempt.phraseId,list);
  }

  // Replay one prompt's graph at a time. Keep just the latest 50 observations
  // across all prompts containing the same writing and reading.
  type History = {phrase:Phrase; clause:Clause; recent:(Observation & {at:number})[]};
  const groups = new Map<string,History>();
  for (const [id,list] of byPhrase) {
    const phrase = verified.get(id)!;
    const source = indexPhrase(phrase);
    if (!source.parts.length) continue;
    for (const attempt of list) {
      for (const [key,sample] of measure(attempt,source)) {
        const group = groups.get(key) ?? {phrase,clause:sample.clause,recent:[]};
        const observations = group.recent;
        if (observations.length === 50 && attempt.endedAt <= observations[49].at) continue;
        const position = observations.findIndex(item=>item.at < attempt.endedAt);
        const index = position < 0 ? observations.length : position;
        observations.splice(index,0,{...sample,at:attempt.endedAt});
        if (observations.length > 50) observations.pop();
        if (index === 0) { group.phrase = phrase; group.clause = sample.clause; }
        groups.set(key,group);
      }
    }
  }
  const baseline = typingBaseline(attempts,phrases);
  const weak:WeakClause[] = [];
  for (const {phrase,clause,recent} of groups.values()) {
    const mistakeAttempts = recent.filter(item=>item.missed).length;
    const intervals = recent.reduce((sum,item)=>sum+item.intervals,0);
    let slowdownPct = null;
    if (recent.length >= 3 && intervals >= 5 && baseline.count >= 20 && baseline.meanMs !== null) {
      const meanMs = recent.reduce((sum,item)=>sum+item.totalMs,0) / intervals;
      const excess = meanMs - baseline.meanMs;
      if (excess >= 20 && excess >= baseline.meanMs * 0.2) slowdownPct = 100 * excess / baseline.meanMs;
    }
    if (mistakeAttempts >= 2 || slowdownPct !== null) weak.push({phrase,clause,attempts:recent.length,mistakeAttempts,slowdownPct});
  }
  return weak.sort((a,b)=>b.mistakeAttempts-a.mistakeAttempts || (b.slowdownPct??0)-(a.slowdownPct??0) || a.clause.text.localeCompare(b.clause.text,'ja'));
}
