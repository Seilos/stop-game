'use strict';

/**
 * Normalizes text for comparison:
 * - Converts to lowercase
 * - Removes accent marks (diacritics)
 * - Trims whitespace
 * - Removes non-alphabetic characters (including numbers)
 */
function normalize(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '');
}

/**
 * Checks if normalized text starts with the given letter
 */
function startsWithLetter(word, letter) {
  const n = normalize(word);
  const l = normalize(letter);
  return n.length > 0 && l.length > 0 && n[0] === l[0];
}

/**
 * Checks if text contains numbers
 */
function containsNumbers(text) {
  return /\d/.test(text || '');
}

module.exports = { normalize, startsWithLetter, containsNumbers };
