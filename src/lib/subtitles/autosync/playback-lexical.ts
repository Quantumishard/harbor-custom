/** Conservative same-language playback correction from Moonshine's timed words.
 *
 * Speech-occupancy matching can reject accurately transcribed dialogue when
 * subtitle cards stay visible longer than the spoken words. Exact text anchors
 * are independent evidence, but must never be used across languages or based
 * on a single common phrase. This helper never logs any transcript text.
 */

export type TimedSpeechToken = { text: string; t0: number; t1: number };
export type TimedSubtitleText = { start: number; end: number; text: string };
export type PlaybackLexicalDiagnostic = {
  candidates: number;
  matches: number;
  consistent: number;
  spanSec: number;
  accepted: boolean;
};

function words(text: string): string[] {
  return (
    text
      .replace(/<[^>]*>|\{[^}]*\}/g, " ")
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Requires three *different* subtitle cues, unique spoken phrase matches and
 * consistent timing across a significant part of the clip. No guessed matches.
 */
export function sameLanguagePlaybackOffset(
  tokens: TimedSpeechToken[],
  cues: TimedSubtitleText[],
  durationSec: number,
  maxLagSec = 30,
  diagnose?: (value: PlaybackLexicalDiagnostic) => void,
): number | null {
  const speech = tokens
    .filter(
      (token) =>
        Number.isFinite(token.t0) &&
        Number.isFinite(token.t1) &&
        token.t1 > token.t0 &&
        token.t0 >= 0 &&
        token.t1 <= durationSec + 0.5,
    )
    .sort((a, b) => a.t0 - b.t0)
    .flatMap((token) =>
      words(token.text).map((text, i) => ({
        text,
        t0: token.t0,
        first: i === 0,
      })),
    );

  const eligible = cues
    .filter(
      (cue) =>
        Number.isFinite(cue.start) &&
        Number.isFinite(cue.end) &&
        cue.end > cue.start &&
        cue.start >= -maxLagSec &&
        cue.start <= durationSec + maxLagSec,
    )
    .map((cue) => ({ ...cue, phrase: words(cue.text) }))
    .filter((cue) => cue.phrase.length >= 3 && cue.phrase.some((word) => word.length >= 5));

  const prefixKey = (phrase: string[]) => phrase.slice(0, Math.min(4, phrase.length)).join(" ");
  const subtitlePrefixUses = new Map<string, number>();
  for (const cue of eligible) {
    const key = prefixKey(cue.phrase);
    subtitlePrefixUses.set(key, (subtitlePrefixUses.get(key) ?? 0) + 1);
  }

  const anchors: Array<{ t: number; lag: number; firstWord: number; wordCount: number }> = [];
  const usedSpeech = new Set<number>();
  let candidateCount = 0;
  for (const cue of eligible) {
    // If a caption's opening words recur, even perfect speech timestamps
    // cannot tell which occurrence is the intended cue.
    if (subtitlePrefixUses.get(prefixKey(cue.phrase)) !== 1) continue;
    // Matching only the opening words makes the anchor correspond to cue.start.
    // Requiring 4 words when available reduces common-phrase false positives.
    const count = Math.min(4, cue.phrase.length);
    const prefix = cue.phrase.slice(0, count);
    const matches: number[] = [];
    for (let i = 0; i + count <= speech.length; i++) {
      if (
        speech[i].first &&
        prefix.every((word, k) => speech[i + k].text === word) &&
        // Never fabricate one phrase across unrelated recognition windows.
        speech[i + count - 1].t0 - speech[i].t0 <= 8 &&
        Math.abs(speech[i].t0 - cue.start) <= maxLagSec
      )
        matches.push(i);
    }
    if (matches.length !== 1) continue;
    candidateCount += 1;
    const index = matches[0];
    if (usedSpeech.has(index)) continue;
    usedSpeech.add(index);
    anchors.push({
      t: speech[index].t0,
      lag: speech[index].t0 - cue.start,
      firstWord: index,
      wordCount: count,
    });
  }

  const sorted = anchors.map((anchor) => anchor.lag).sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[sorted.length >> 1]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : 0;
  const consistent = anchors.filter((anchor) => Math.abs(anchor.lag - median) <= 0.65);
  const spanSec =
    consistent.length > 1
      ? Math.max(...consistent.map((anchor) => anchor.t)) -
        Math.min(...consistent.map((anchor) => anchor.t))
      : 0;
  // A compact exchange can support a scene-only offer if every phrase agrees
  // and each contributes its own words, rather than overlapping another cue.
  const ordered = consistent.slice().sort((a, b) => a.firstWord - b.firstWord);
  const compactExchange =
    spanSec >= 8 &&
    ordered.length >= 4 &&
    ordered.length === anchors.length &&
    ordered.every(
      (a, i) => i === 0 || a.firstWord >= ordered[i - 1].firstWord + ordered[i - 1].wordCount,
    );
  const accepted =
    consistent.length >= 3 &&
    consistent.length >= Math.ceil(anchors.length * 0.8) &&
    (spanSec >= 12 || compactExchange) &&
    Math.abs(median) <= maxLagSec;
  diagnose?.({
    candidates: eligible.length,
    matches: candidateCount,
    consistent: consistent.length,
    spanSec: Math.round(spanSec * 10) / 10,
    accepted,
  });
  // A single-scene offset is offered for confirmation, never auto-applied.
  return accepted ? (Math.abs(median) < 0.35 ? 0 : median) : null;
}
