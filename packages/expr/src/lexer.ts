import { ExprError, EXPR_ERRORS } from './types.js';

export type TokKind =
  | 'num'
  | 'str'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'dot'
  | 'eof';

export interface Token {
  readonly kind: TokKind;
  readonly text: string;
  readonly pos: number;
  /** Present only for `num` and `str`, so the parser never re-parses a literal. */
  readonly value?: string | number;
}

/**
 * Multi-character operators must be tested before their single-character prefixes, or `>=` lexes
 * as `>` followed by a stray `=`. Order in this array is load-bearing.
 */
const MULTI_OPS = ['==', '!=', '>=', '<=', '&&', '||'] as const;
const SINGLE_OPS = ['>', '<', '!', '+', '-', '*', '/', '%'] as const;

/** Word operators. `in`/`contains`/`matches` are keywords, not identifiers. */
const WORD_OPS = new Set(['in', 'contains', 'matches']);

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    if (c === undefined) break;

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }

    // Numbers — integer or decimal. No exponent notation: it has never been needed here and
    // leaving it out keeps the grammar smaller.
    if (isDigit(c)) {
      const start = i;
      while (i < src.length && isDigit(src[i] ?? '')) i += 1;
      if (src[i] === '.' && isDigit(src[i + 1] ?? '')) {
        i += 1;
        while (i < src.length && isDigit(src[i] ?? '')) i += 1;
      }
      const text = src.slice(start, i);
      toks.push({ kind: 'num', text, pos: start, value: Number(text) });
      continue;
    }

    // Strings — single or double quoted, with backslash escapes.
    if (c === '"' || c === "'") {
      const quote = c;
      const start = i;
      i += 1;
      let out = '';
      let closed = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === undefined) break;
        if (ch === '\\') {
          const nxt = src[i + 1];
          if (nxt === undefined) {
            throw new ExprError(EXPR_ERRORS.SYNTAX, 'Unterminated escape in string.', i);
          }
          out +=
            nxt === 'n' ? '\n' : nxt === 't' ? '\t' : nxt === 'r' ? '\r' : nxt;
          i += 2;
          continue;
        }
        if (ch === quote) {
          i += 1;
          closed = true;
          break;
        }
        out += ch;
        i += 1;
      }
      if (!closed) {
        throw new ExprError(EXPR_ERRORS.SYNTAX, 'Unterminated string literal.', start);
      }
      toks.push({ kind: 'str', text: src.slice(start, i), pos: start, value: out });
      continue;
    }

    // Identifiers, keywords and word operators
    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i] ?? '')) i += 1;
      const text = src.slice(start, i);
      toks.push({ kind: WORD_OPS.has(text) ? 'op' : 'ident', text, pos: start });
      continue;
    }

    // Multi-char operators before single-char (see MULTI_OPS note).
    const two = src.slice(i, i + 2);
    if ((MULTI_OPS as readonly string[]).includes(two)) {
      toks.push({ kind: 'op', text: two, pos: i });
      i += 2;
      continue;
    }

    if ((SINGLE_OPS as readonly string[]).includes(c)) {
      toks.push({ kind: 'op', text: c, pos: i });
      i += 1;
      continue;
    }

    // A bare `=` is almost always a typo for `==`. Say so, rather than "unexpected character".
    if (c === '=') {
      throw new ExprError(
        EXPR_ERRORS.SYNTAX,
        'Single "=" is not valid. Use "==" to compare.',
        i,
      );
    }

    switch (c) {
      case '(':
        toks.push({ kind: 'lparen', text: c, pos: i });
        i += 1;
        continue;
      case ')':
        toks.push({ kind: 'rparen', text: c, pos: i });
        i += 1;
        continue;
      case '[':
        toks.push({ kind: 'lbracket', text: c, pos: i });
        i += 1;
        continue;
      case ']':
        toks.push({ kind: 'rbracket', text: c, pos: i });
        i += 1;
        continue;
      case ',':
        toks.push({ kind: 'comma', text: c, pos: i });
        i += 1;
        continue;
      case '.':
        toks.push({ kind: 'dot', text: c, pos: i });
        i += 1;
        continue;
      default:
        throw new ExprError(EXPR_ERRORS.SYNTAX, `Unexpected character "${c}".`, i);
    }
  }

  toks.push({ kind: 'eof', text: '', pos: src.length });
  return toks;
}
