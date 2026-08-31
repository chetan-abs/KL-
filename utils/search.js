// Shared search-query normalization used across all list screens.
// Folds away the punctuation and spacing that differ between how a value was
// entered and how it is typed back, then requires a minimum length before a
// search actually filters (avoids noisy matches on a single character).

export const MIN_SEARCH_LENGTH = 2;

// Characters treated as noise: whitespace and the separators that appear in
// item codes, phone numbers, GST numbers and addresses. Everything else is
// kept.
//
// This replaces a [^a-zA-Z0-9] allow-list, which discarded every character
// outside ASCII. Customer and item names are stored utf8mb4 and in practice
// contain Devanagari and accented Latin, all of which normalized to the empty
// string — those records could not be searched at all, and any two of them
// looked identical to the matcher.
const NOISE = /[\s\-_.,;:/\\()[\]{}#&@'"*+|~`^%$!?<>=]/g;

// Unicode combining marks, left behind by the NFKD decomposition below.
// Written as escapes because the marks are invisible in source.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

// Strips noise characters and lowercases; other characters pass through.
export function normalizeSearch(raw) {
  return String(raw ?? '')
    // Splits accented characters into base + combining mark so "José" and
    // "Jose" fold together.
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(NOISE, '')
    .toLowerCase();
}

// True once the normalized query meets the minimum length to search.
export function isSearchActive(raw) {
  return normalizeSearch(raw).length >= MIN_SEARCH_LENGTH;
}
