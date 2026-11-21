import { crossLanguagePlaybackOffset, type SpeechTimingDiagnostic } from "./drift-dsp";
import {
  sameLanguagePlaybackOffset,
  type PlaybackLexicalDiagnostic,
  type TimedSubtitleText,
} from "./playback-lexical";
import { normalizeLang } from "../language";
import {
  resolveMoonshineLanguage,
  moonshineMissingModelError,
  moonshineMissingModelLanguage,
} from "./moonshine-models";

type Window = {
  startSec: number;
  lenSec: number;
  tokens: Array<{ text: string; t0: number; t1: number }>;
  stats?: {
    recognizedLines?: number;
    wordCandidates?: number;
    wordIntervals?: number;
    lineIntervals?: number;
    audioRms?: number;
    audioPeak?: number;
    chunkRetry?: boolean;
    retryRecognizedLines?: number;
    retryWordCandidates?: number;
    retryLineIntervals?: number;
    retryTimedIntervals?: number;
  };
};

export type MoonshineTimingDiagnostic = {
  modelLanguage: string;
  windows: number;
  recognizedLines: number;
  wordCandidates: number;
  wordIntervals: number;
  lineIntervals: number;
  audioRms: number;
  audioPeak: number;
  chunkRetries: number;
  retryRecognizedLines: number;
  retryWordCandidates: number;
  retryTimedIntervals: number;
  acceptedIntervals: number;
};

class PlaybackSpeechError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Never export arbitrary native errors: they can contain paths or media URLs. */
export function playbackSpeechFailureCode(error: unknown): string {
  if (error instanceof PlaybackSpeechError) return error.code;
  if (moonshineMissingModelLanguage(error)) return "model-missing";
  const message = error instanceof Error ? error.message : String(error);
  if (message === "subsync-scene-timeout") return "timeout";
  if (message === "Sync cancelled.") return "cancelled";
  return "native-error";
}

/** The short prepared playback audio is transcribed in an isolated Moonshine worker. */
export async function matchPlaybackSpeech(
  input: {
    path: string;
    durationSec: number;
    cues: Array<[number, number]>;
    textCues?: TimedSubtitleText[];
    audioLanguage?: string;
    audioTrackTitle?: string;
    subtitleLanguage?: string;
    modelLanguage?: string;
    enabled: boolean;
    crossLanguage: boolean;
    sessionId: string;
  },
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
  progress: (message: string) => void,
  isCurrent: () => boolean,
  diagnose?: (value: MoonshineTimingDiagnostic) => void,
  diagnoseFit?: (value: SpeechTimingDiagnostic) => void,
  diagnoseLexical?: (value: PlaybackLexicalDiagnostic) => void,
): Promise<{ offsetSec: number; confidence: number }> {
  if (!input.enabled)
    throw new PlaybackSpeechError(
      "disabled",
      "Moonshine was not used. Enable Smart resync with speech recognition in Auto sync settings.",
    );
  const modelLanguage = resolveMoonshineLanguage(
    input.modelLanguage,
    input.audioLanguage,
    input.audioTrackTitle,
  );
  const taggedAudio = normalizeLang(input.audioLanguage ?? "");
  // A manual override corrects an incorrectly tagged audio track for both
  // recognition and matching eligibility. Auto mode still trusts audio metadata.
  const audio =
    input.modelLanguage && input.modelLanguage !== "auto"
      ? (modelLanguage ?? "")
      : taggedAudio && !["und", "mul", "zxx", "mis"].includes(taggedAudio)
        ? taggedAudio
        : (modelLanguage ?? "");
  const subtitle = normalizeLang(input.subtitleLanguage ?? "");
  if (
    audio &&
    subtitle &&
    audio !== "und" &&
    subtitle !== "und" &&
    audio !== subtitle &&
    !input.crossLanguage
  ) {
    throw new PlaybackSpeechError(
      "cross-language-off",
      "Cross-language matching is off. Enable Match subtitles across languages in Auto sync settings.",
    );
  }
  if (!modelLanguage) {
    throw new PlaybackSpeechError(
      "language-unsupported",
      input.modelLanguage && input.modelLanguage !== "auto"
        ? "Moonshine does not support the chosen override language. Silero remains available."
        : "Moonshine cannot select a supported model from this audio track. Silero remains available; you can choose a language manually in Settings.",
    );
  }
  const status = await invoke<{
    supported: boolean;
    runtimeInstalled: boolean;
    installed: boolean;
  }>("moonshine_model_status", { language: modelLanguage });
  if (!isCurrent()) throw new Error("Sync cancelled.");
  if (!status.supported)
    throw new PlaybackSpeechError(
      "python-missing",
      "Moonshine testing requires Python 3. Install Python first.",
    );
  if (!status.runtimeInstalled)
    throw new PlaybackSpeechError(
      "runtime-missing",
      "Install the Moonshine testing runtime in Auto sync settings first.",
    );
  if (!status.installed) throw moonshineMissingModelError(modelLanguage);
  progress("Recognizing buffered dialogue with Moonshine");
  const windows = await invoke<Window[]>("moonshine_transcribe_windows", {
    url: input.path,
    headers: null,
    durationSec: input.durationSec,
    subLang: modelLanguage,
    probeCount: 1,
    windowSec: Math.min(35, input.durationSec - 10),
    mapSpec: "0:a:0",
    sessionId: input.sessionId,
  });
  if (!isCurrent()) throw new Error("Sync cancelled.");
  const totals = windows.reduce(
    (stats, window) => {
      const next = window.stats;
      stats.recognizedLines += next?.recognizedLines ?? 0;
      stats.wordCandidates += next?.wordCandidates ?? 0;
      stats.wordIntervals += next?.wordIntervals ?? 0;
      stats.lineIntervals += next?.lineIntervals ?? 0;
      stats.audioRms = Math.max(stats.audioRms, next?.audioRms ?? 0);
      stats.audioPeak = Math.max(stats.audioPeak, next?.audioPeak ?? 0);
      stats.chunkRetries += next?.chunkRetry ? 1 : 0;
      stats.retryRecognizedLines += next?.retryRecognizedLines ?? 0;
      stats.retryWordCandidates += next?.retryWordCandidates ?? 0;
      stats.retryTimedIntervals += next?.retryTimedIntervals ?? 0;
      return stats;
    },
    {
      modelLanguage,
      windows: windows.length,
      recognizedLines: 0,
      wordCandidates: 0,
      wordIntervals: 0,
      lineIntervals: 0,
      audioRms: 0,
      audioPeak: 0,
      chunkRetries: 0,
      retryRecognizedLines: 0,
      retryWordCandidates: 0,
      retryTimedIntervals: 0,
      acceptedIntervals: 0,
    },
  );
  const speech: Array<[number, number]> = windows.flatMap((window) =>
    window.tokens
      .filter(
        (token) =>
          /[\p{L}\p{N}]/u.test(token.text) &&
          Number.isFinite(token.t0) &&
          Number.isFinite(token.t1) &&
          token.t1 > token.t0,
      )
      .map((token) => [token.t0, token.t1] as [number, number]),
  );
  totals.acceptedIntervals = speech.length;
  diagnose?.(totals);
  if (!speech.length) {
    if (totals.audioPeak < 0.002 && totals.windows > 0) {
      throw new PlaybackSpeechError(
        "audio-silent",
        "The extracted playback audio is nearly silent. Play a scene with audible dialogue and try again.",
      );
    }
    if (totals.recognizedLines + totals.retryRecognizedLines === 0) {
      throw new PlaybackSpeechError(
        "no-speech",
        "Moonshine did not recognize speech in the sampled audio. Check that its selected language matches the audio track, or try a different dialogue scene.",
      );
    }
    throw new PlaybackSpeechError(
      "timestamps-missing",
      "Moonshine recognized some dialogue but could not provide reliable word or phrase timestamps for this sample. Try another dialogue scene.",
    );
  }
  progress("Comparing Moonshine speech timestamps with subtitles");
  const timingOffset = crossLanguagePlaybackOffset(speech, input.cues, windows, 30, diagnoseFit);
  if (timingOffset !== null) return { offsetSec: timingOffset, confidence: 0.65 };

  // Subtitle display intervals often outlast the spoken words. Unique exact
  // dialogue anchors can recover the same-language case when occupancy fails.
  // Untagged local SRT files are allowed: the matching words themselves must
  // prove the language. A *known* different subtitle language still blocks
  // lexical matching, and fabricated embedded-cue labels are never eligible.
  const unknownSubtitleLanguage =
    !subtitle || ["und", "mul", "zxx", "mis"].includes(subtitle);
  const textOffset =
    audio &&
    (unknownSubtitleLanguage || audio.split("-")[0] === subtitle.split("-")[0]) &&
    input.textCues?.length
      ? sameLanguagePlaybackOffset(
          windows.flatMap((window) => window.tokens),
          input.textCues,
          input.durationSec,
          30,
          diagnoseLexical,
        )
      : null;
  if (textOffset !== null) return { offsetSec: textOffset, confidence: 0.65 };

  throw new PlaybackSpeechError(
    "alignment-rejected",
    "Moonshine processed the audio, but neither speech timing nor matching dialogue established a reliable shift. Try another dialogue scene or Manual offset.",
  );
}
