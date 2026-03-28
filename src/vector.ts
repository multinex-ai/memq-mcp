import { createHash } from "node:crypto";

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "is",
  "are",
  "be",
  "with",
  "that",
  "this",
  "it",
  "as",
  "at",
  "from",
  "by",
  "we",
  "you",
  "our",
  "their",
  "was",
  "were",
  "has",
  "have",
  "had",
  "will",
  "can",
  "could",
  "should",
  "would",
  "not",
  "but",
  "if",
  "then",
  "than",
  "do",
  "does",
  "did",
  "into",
  "about",
  "over",
  "under",
  "across",
  "after",
  "before",
  "using",
  "use",
  "used",
  "more",
]);

export function tokenizeText(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_\-]+/g) ?? [];
}

export function extractEntities(text: string): string[] {
  const set = new Set<string>();
  const matches = text.match(/[#@]?[A-Za-z][A-Za-z0-9_\-]{2,}/g) ?? [];
  for (const token of matches) {
    const lower = token.toLowerCase();
    if ((token[0] === "#" || token[0] === "@") || (!STOPWORDS.has(lower) && token !== lower)) {
      set.add(token);
    }
  }
  return [...set].sort();
}

export function topTermsFromTexts(texts: string[], limit = 10): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of tokenizeText(text)) {
      if (token.length <= 2 || STOPWORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

export function embedText(text: string, dim: number, seed = "mnemosyne-hash-embed-v1"): number[] {
  const vec = new Array<number>(dim).fill(0);
  const words = tokenizeText(text);
  if (words.length === 0) return vec;

  for (const token of words) {
    const digest = createHash("sha256").update(`${seed}:${token}`).digest();
    for (let offset = 0; offset < 32; offset += 4) {
      const idx = ((digest[offset] << 8) + digest[offset + 1]) % dim;
      const sign = digest[offset + 2] % 2 === 0 ? 1 : -1;
      const val = (digest[offset + 3] / 255) * sign;
      vec[idx] += val;
    }
  }

  const norm = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
