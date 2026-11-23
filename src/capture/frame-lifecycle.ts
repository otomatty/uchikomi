import { signatureDistance } from './helpers';
import type { CompletionBoundary } from './key-boundary';
import { StableScoreReader, type ParsedScore, type ScoreType } from './score-parser';

interface PromptTransition {
  interruptedAt?: number;
  candidate?: { at: number; contiguous: boolean };
}

/** Only two stable samples with no intervening unknown prompt are contiguous. */
export class PromptSignatureTracker {
  private last: Uint8Array | null = null;
  private pending: { bytes: Uint8Array; at: number } | null = null;
  reset() { this.last = this.pending = null; }
  observe(bytes: Uint8Array, at: number): PromptTransition {
    if (!this.pending && this.last && signatureDistance(bytes, this.last) < .018) return {};
    let interruptedAt: number | undefined;
    if (this.pending && signatureDistance(bytes, this.pending.bytes) > .018) {
      // A word may have appeared and disappeared between stable samples. Never
      // carry the older completion key over that unobserved word to a successor.
      interruptedAt = this.pending.at;
      this.last = this.pending = null;
    }
    if (!this.pending) {
      this.pending = { bytes, at };
      return { interruptedAt };
    }
    const candidate = { at: this.pending.at, contiguous: this.last !== null };
    this.last = bytes; this.pending = null;
    return { interruptedAt, candidate };
  }
}

interface ObservedBoundary {
  endedAt?: number;
  reliableBoundary: boolean;
  completionBoundary: CompletionBoundary;
}

/** A detected result closes the final word normally; an unknown loss cannot. */
export function closeObservedBoundary(candidate: ObservedBoundary, at: number, observedExit: boolean): boolean {
  if (candidate.endedAt !== undefined) return false;
  if (!observedExit) {
    candidate.reliableBoundary = false;
    candidate.completionBoundary.settle(null);
  }
  candidate.endedAt = at;
  return true;
}

/** Preserve capture order even when OCR of an earlier receipt is still queued. */
export class ResultFrameSequence {
  private reader = new StableScoreReader();
  private revision = 0;
  constructor(private scoreType: ScoreType) {}
  scanned(found: boolean, at: number): number {
    if (!found) {
      this.revision++;
      this.reader.observe({ kind: 'none', scoreType: this.scoreType, confidence: 0 }, at);
    }
    return this.revision;
  }
  observe(parsed: ParsedScore, at: number, revision: number): ParsedScore | null {
    if (revision !== this.revision) return null;
    return this.reader.observe(parsed, at);
  }
}
