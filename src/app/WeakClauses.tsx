import { useMemo } from 'react';
import { BookOpen, Play } from 'lucide-react';
import { analyzeClauses } from '../core/clause-stats';
import { clauseTarget } from '../core/clauses';
import { kanaToRoman } from '../core/romaji';
import type { PracticePhrase } from '../core/types';
import { EmptyState, useApp } from './shared';

export default function WeakClauses({search,onPractice}:{search:string;onPractice:(phrase:PracticePhrase)=>void}) {
  const {data} = useApp();
  const weak = useMemo(() => analyzeClauses(data.attempts,data.phrases), [data.attempts,data.phrases]);
  const query = search.trim().toLowerCase();
  const matches = weak.filter(({phrase,clause}) => [phrase.text,clause.text,clause.reading,kanaToRoman(clause.reading)].some(s=>s.toLowerCase().includes(query)));
  if (!matches.length) return <div className="words-empty"><EmptyState symbol={<BookOpen size={30}/>}
    title={query ? '一致する文節がありません' : '苦手な文節はまだありません'}
    body={query ? '元のお題や文節の読みでも検索できます。' : '確認済みのお題の打鍵履歴から、繰り返しミスした文節や、打鍵が遅い文節を抽出します。'}/>
  </div>;
  return <ul className="clause-list" aria-label="苦手な文節">{matches.map(({phrase,clause,attempts,mistakeAttempts,slowdownPct}) =>
    <li key={JSON.stringify([clause.text,clause.reading])}>
      <div><strong>{clause.text}</strong> <span>{clause.reading}</span>
        <p>元のお題「{phrase.text}」</p>
        <small>{[mistakeAttempts >= 2 && `入力${attempts}回中${mistakeAttempts}回でミス`,
          slowdownPct !== null && `打鍵間隔が平均より${Math.round(slowdownPct)}%長い`].filter(Boolean).join(' · ')}</small>
      </div>
      <button className="button secondary small" aria-label={`「${clause.text}」だけを5回練習`} onClick={()=>onPractice(clauseTarget(phrase,clause))}><Play size={15}/>5回練習</button>
    </li>
  )}</ul>;
}
