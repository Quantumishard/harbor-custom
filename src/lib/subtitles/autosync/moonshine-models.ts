import { normalizeLang } from "../language";

export const MOONSHINE_LANGUAGES = [
  ["en", "English"],
  ["ar", "Arabic"],
  ["de", "German"],
  ["es", "Spanish"],
  ["ja", "Japanese"],
  ["zh", "Mandarin"],
  ["tl", "Tagalog"],
  ["vi", "Vietnamese"],
] as const;

export type MoonshineLanguage = (typeof MOONSHINE_LANGUAGES)[number][0];
export type MoonshineLanguageMode = "auto" | MoonshineLanguage;
export type MoonshineModelStatus = {
  supported: boolean;
  runtimeInstalled: boolean;
  installed: boolean;
  language: string;
};

const supported = new Set<string>(MOONSHINE_LANGUAGES.map(([code]) => code));

export function isMoonshineLanguage(code: string): code is MoonshineLanguage {
  return supported.has(code);
}

export function moonshineLanguageName(code: string): string {
  return MOONSHINE_LANGUAGES.find(([key]) => key === code)?.[1] ?? code;
}

/** Only an explicitly prefixed language in the selected audio track title is reliable.
 * Some MKVs omit the language tag despite naming their audio streams, e.g.
 * "English : DTS-HD Master Audio 5.1". Never inspect a media or subtitle title.
 */
function languageFromAudioTrackTitle(title: string | null | undefined): MoonshineLanguage | null {
  const match = (title ?? "").trim().match(
    /^(English|Arabic|German|Spanish|Japanese|Mandarin|Chinese|Tagalog|Filipino|Vietnamese)(?:\s*\([^)]{1,40}\))?\s*(?::|[-|]|$)/i,
  );
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (name === "chinese") return "zh";
  if (name === "filipino") return "tl";
  return MOONSHINE_LANGUAGES.find(([, label]) => label.toLowerCase() === name)?.[0] ?? null;
}

/**
 * Respect explicit override, then the selected AUDIO track's language tag.
 * Only when the tag is missing/unknown may its clearly labelled track title
 * supply the language. An unsupported known tag must not be overridden.
 */
export function resolveMoonshineLanguage(
  preference: string | null | undefined,
  audioTrackLanguage: string | null | undefined,
  audioTrackTitle?: string | null,
): MoonshineLanguage | null {
  const moonshineCode = (value: string) => {
    const normalized = normalizeLang(value);
    const base = normalized?.split("-")[0];
    return base && isMoonshineLanguage(base) ? base : null;
  };
  if (preference && preference !== "auto") {
    return moonshineCode(preference);
  }
  const tagged = normalizeLang(audioTrackLanguage).split("-")[0];
  if (tagged && !["und", "mul", "zxx", "mis"].includes(tagged))
    return isMoonshineLanguage(tagged) ? tagged : null;
  return languageFromAudioTrackTitle(audioTrackTitle);
}

// The full auto-sync pipeline can discover that speech recognition needs a
// model without going through Sync from playback. Only the active player can
// turn this signal into a prompt. There is no download side effect here.
const missingModelListeners = new Set<(language: MoonshineLanguage) => void>();
export function onMoonshineModelMissing(
  callback: (language: MoonshineLanguage) => void,
): () => void {
  missingModelListeners.add(callback);
  return () => {
    missingModelListeners.delete(callback);
  };
}
export function announceMoonshineModelMissing(language: MoonshineLanguage): void {
  for (const listener of missingModelListeners) listener(language);
}

export const MOONSHINE_MISSING_MODEL_CODE = "moonshine-model-not-installed";

export function moonshineMissingModelError(language: MoonshineLanguage): Error {
  return new Error(`${MOONSHINE_MISSING_MODEL_CODE}:${language}`);
}

export function moonshineMissingModelLanguage(error: unknown): MoonshineLanguage | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(`${MOONSHINE_MISSING_MODEL_CODE}:`)) return null;
  const code = message.slice(MOONSHINE_MISSING_MODEL_CODE.length + 1);
  return isMoonshineLanguage(code) ? code : null;
}
