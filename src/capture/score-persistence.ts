import { getData, saveAutomaticScore, type AutomaticScore } from '../core/db';
import type { CaptureStatus, Session } from '../core/types';

interface CaptureScoreResult {
  saved: boolean;
  latestScore: NonNullable<CaptureStatus['latestScore']>;
}

/** Keep database readbacks separate from the session owned by capture writes. */
export async function saveCaptureScore(session: Session, patch: AutomaticScore): Promise<CaptureScoreResult | null> {
  if (patch.scoreType !== 'total') throw new Error('スコアは食べた金額の合計で指定してください。');
  const saved = await saveAutomaticScore(session.id, patch);
  let displayed = session;
  if (saved) {
    Object.assign(session, patch, { scoreSource: 'ocr' as const });
    delete session.scoreReview;
  } else {
    const existing = (await getData()).sessions.find(item => item.id === session.id);
    if (!existing || existing.score === undefined) return null;
    // This snapshot is for the notification only. Copying a manual score into
    // the live session would make a later counter/stop write look like a new
    // manual edit, overwriting any correction made after this readback.
    displayed = existing;
  }
  if (displayed.score === undefined) return null;
  return {
    saved,
    latestScore: {
      sessionId: session.id, score: displayed.score, scoreType: 'total',
      confidence: displayed.scoreConfidence,
    },
  };
}
