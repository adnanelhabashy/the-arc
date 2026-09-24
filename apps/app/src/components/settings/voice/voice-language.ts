export const VOICE_LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  auto: "Auto",
  zh: "Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  de: "German",
  fr: "French",
  ru: "Russian",
  pt: "Portuguese",
  es: "Spanish",
  it: "Italian",
  he: "Hebrew",
  ar: "Arabic",
  da: "Danish",
  el: "Greek",
  fi: "Finnish",
  hi: "Hindi",
  ms: "Malay",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  sv: "Swedish",
  sw: "Swahili",
  tr: "Turkish",
};

export function voiceLanguageLabel(language: string): string {
  return VOICE_LANGUAGE_LABELS[language] ?? language;
}
