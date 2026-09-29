import { describe, expect, it } from 'vitest';

import { evaluate, evaluateBoolean, parse, validateExpression } from './index.js';
import {
  collectReferences,
  interpolateString,
  interpolateValue,
  referenceRoot,
} from './interpolate.js';
import { ExprError, EXPR_ERRORS, type ExprValue } from './types.js';

/** Evaluate with a fixed clock so `now()` is deterministic. */
const FIXED_NOW = 1_759_000_000_000; // 2025-09-27T…Z
const ev = (src: string, scope: Record<string, ExprValue> = {}): ExprValue =>
  evaluate(parse(src), scope, { nowMs: FIXED_NOW });

const scope: Record<string, ExprValue> = {
  steps: {
    fetch: {
      output: {
        status: 200,
        body: {
          count: 42,
          ok: true,
          name: 'Feranmi',
          items: [{ id: 'a', qty: 2 }, { id: 'b', qty: 0 }],
          nested: { deep: { value: 'found' } },
          nothing: null,
        },
      },
    },
    shell: { output: { exit_code: 0, stdout: 'done\n' } },
  },
  secrets: { API_KEY: 'sk_live_abc123' },
  vars: { threshold: 10, label: 'prod' },
  run: { id: 'r_01HV', attempt: 1 },
};

describe('literals', () => {
  it('parses numbers, strings, booleans and null', () => {
    expect(ev('42')).toBe(42);
    expect(ev('1.5')).toBe(1.5);
    expect(ev('"hi"')).toBe('hi');
    expect(ev("'hi'")).toBe('hi');
    expect(ev('true')).toBe(true);
    expect(ev('false')).toBe(false);
    expect(ev('null')).toBe(null);
  });

  it('handles escapes in strings', () => {
    expect(ev('"a\\nb"')).toBe('a\nb');
    expect(ev('"say \\"hi\\""')).toBe('say "hi"');
    expect(ev('"tab\\there"')).toBe('tab\there');
  });

  it('rejects an unterminated string', () => {
    expect(() => ev('"oops')).toThrow(ExprError);
  });
});

describe('paths', () => {
  it('resolves nested properties', () => {
    expect(ev('steps.fetch.output.status', scope)).toBe(200);
    expect(ev('steps.fetch.output.body.name', scope)).toBe('Feranmi');
    expect(ev('steps.fetch.output.body.nested.deep.value', scope)).toBe('found');
  });

  it('indexes arrays, including negative indices from the end', () => {
    expect(ev('steps.fetch.output.body.items[0].id', scope)).toBe('a');
    expect(ev('steps.fetch.output.body.items[1].qty', scope)).toBe(0);
    expect(ev('steps.fetch.output.body.items[-1].id', scope)).toBe('b');
  });

  it('supports computed indices', () => {
    expect(ev('steps.fetch.output.body.items[1 - 1].id', scope)).toBe('a');
    expect(
      ev('steps.fetch.output.body.items[len(steps.fetch.output.body.items) - 1].id', scope),
    ).toBe('b');
  });

  it('returns undefined for a missing path when not strict', () => {
    expect(ev('steps.nope.output', scope)).toBeUndefined();
    expect(ev('steps.fetch.output.body.missing', scope)).toBeUndefined();
  });

  it('distinguishes an explicit null from a missing key', () => {
    expect(ev('steps.fetch.output.body.nothing', scope)).toBe(null);
    expect(ev('has(steps.fetch.output.body.nothing)', scope)).toBe(false);
    expect(ev('has(steps.fetch.output.body.count)', scope)).toBe(true);
  });
});

describe('security: prototype access is refused', () => {
  // These are the tests that matter most in this file. A path that reaches the prototype chain is
  // rejected at PARSE time, so such an expression cannot even be stored in a task graph.
  it.each([
    '__proto__',
    'constructor',
    'prototype',
    '__defineGetter__',
    '__lookupGetter__',
  ])('rejects a bare %s segment', (seg) => {
    expect(() => parse(`steps.${seg}`)).toThrow(ExprError);
    try {
      parse(`steps.${seg}`);
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.UNSAFE_PATH);
    }
  });

  it('rejects a constant string index reaching the prototype', () => {
    expect(() => parse('steps["__proto__"]')).toThrow(ExprError);
    expect(() => parse('steps["constructor"]')).toThrow(ExprError);
  });

  it('rejects a COMPUTED string index reaching the prototype at eval time', () => {
    // Parse-time checking cannot see this one, so the evaluator must catch it.
    const src = 'steps["__pro" + "to__"]';
    expect(() => ev(src, scope)).toThrow(ExprError);
    try {
      ev(src, scope);
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.UNSAFE_PATH);
    }
  });

  it('does not read inherited properties', () => {
    // toString exists on Object.prototype but is not an own property of the scope object.
    expect(ev('vars.toString', scope)).toBeUndefined();
    expect(ev('vars.hasOwnProperty', scope)).toBeUndefined();
  });

  it('cannot reach a global', () => {
    expect(ev('process', {})).toBeUndefined();
    expect(ev('globalThis', {})).toBeUndefined();
    expect(ev('Function', {})).toBeUndefined();
  });
});

describe('operators', () => {
  it('compares numbers', () => {
    expect(ev('1 < 2')).toBe(true);
    expect(ev('2 <= 2')).toBe(true);
    expect(ev('3 > 4')).toBe(false);
    expect(ev('4 >= 4')).toBe(true);
  });

  it('compares strings lexicographically', () => {
    expect(ev('"a" < "b"')).toBe(true);
    expect(ev('"b" <= "a"')).toBe(false);
  });

  it('refuses to compare mixed types rather than coercing', () => {
    // "10" < 9 being true is the bug this prevents.
    expect(() => ev('"10" < 9')).toThrow(ExprError);
    try {
      ev('"10" < 9');
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.TYPE_ERROR);
    }
  });

  it('does not coerce across types in equality', () => {
    expect(ev('"0" == 0')).toBe(false);
    expect(ev('1 == true')).toBe(false);
    expect(ev('"" == null')).toBe(false);
  });

  it('treats null and undefined as the same absence', () => {
    expect(ev('steps.missing.thing == null', scope)).toBe(true);
    expect(ev('null == null')).toBe(true);
  });

  it('compares objects and arrays structurally, key order independent', () => {
    const s: Record<string, ExprValue> = { a: { x: 1, y: 2 }, b: { y: 2, x: 1 }, c: [1, 2] };
    expect(ev('a == b', s)).toBe(true);
    expect(ev('c == c', s)).toBe(true);
  });

  it('does arithmetic', () => {
    expect(ev('2 + 3')).toBe(5);
    expect(ev('10 - 4')).toBe(6);
    expect(ev('3 * 4')).toBe(12);
    expect(ev('10 / 4')).toBe(2.5);
    expect(ev('10 % 3')).toBe(1);
    expect(ev('-5 + 1')).toBe(-4);
  });

  it('throws on division and modulo by zero rather than yielding Infinity/NaN', () => {
    expect(() => ev('1 / 0')).toThrow(ExprError);
    expect(() => ev('1 % 0')).toThrow(ExprError);
  });

  it('concatenates when either side of + is a string', () => {
    expect(ev('"a" + "b"')).toBe('ab');
    expect(ev('"n=" + 5')).toBe('n=5');
    expect(ev('5 + "=n"')).toBe('5=n');
  });

  it('respects precedence and grouping', () => {
    expect(ev('2 + 3 * 4')).toBe(14);
    expect(ev('(2 + 3) * 4')).toBe(20);
    expect(ev('1 + 2 < 4 && 5 > 3')).toBe(true);
    expect(ev('!(1 > 2)')).toBe(true);
  });

  it('is left-associative for subtraction', () => {
    expect(ev('10 - 3 - 2')).toBe(5);
  });

  it('short-circuits && and ||', () => {
    // If && evaluated the right side eagerly, this would throw on the bad comparison.
    expect(ev('false && ("x" < 1)')).toBe(false);
    expect(ev('true || ("x" < 1)')).toBe(true);
  });

  it('short-circuiting makes has() guards safe', () => {
    const src = 'has(steps.fetch.output.body.count) && steps.fetch.output.body.count > 10';
    expect(ev(src, scope)).toBe(true);
    const src2 = 'has(steps.nope.output.count) && steps.nope.output.count > 10';
    expect(ev(src2, scope)).toBe(false);
  });

  it('handles in / contains', () => {
    expect(ev('"era" in "Feranmi"')).toBe(true);
    expect(ev('"Feranmi" contains "era"')).toBe(true);
    expect(ev('2 in vars', { vars: [1, 2, 3] })).toBe(true);
    expect(ev('vars contains 9', { vars: [1, 2, 3] })).toBe(false);
    expect(ev('"threshold" in vars', scope)).toBe(true);
  });

  it('handles matches', () => {
    expect(ev('"abc123" matches "^[a-z]+[0-9]+$"')).toBe(true);
    expect(ev('"ABC" matches "^[a-z]+$"')).toBe(false);
  });

  it('rejects an invalid regex with a clear identity', () => {
    try {
      ev('"x" matches "("');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.BAD_REGEX);
    }
  });

  it('caps regex pattern length', () => {
    const long = 'a'.repeat(600);
    try {
      ev(`"x" matches "${long}"`);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.BAD_REGEX);
    }
  });

  it('caps the input length a regex is tested against', () => {
    const big = 'a'.repeat(200_000);
    try {
      evaluate(parse('x matches "^a+$"'), { x: big }, { nowMs: FIXED_NOW });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.TOO_COMPLEX);
    }
  });
});

describe('functions', () => {
  it('len over string, array and object', () => {
    expect(ev('len("hello")')).toBe(5);
    expect(ev('len(steps.fetch.output.body.items)', scope)).toBe(2);
    expect(ev('len(vars)', scope)).toBe(2);
    expect(ev('len(steps.fetch.output.body.nothing)', scope)).toBe(0);
  });

  it('string helpers', () => {
    expect(ev('lower("ABC")')).toBe('abc');
    expect(ev('upper("abc")')).toBe('ABC');
    expect(ev('trim("  x  ")')).toBe('x');
    expect(ev('split("a,b,c", ",")')).toEqual(['a', 'b', 'c']);
    expect(ev('join(x, "-")', { x: ['a', 'b'] })).toBe('a-b');
  });

  it('numeric coercion returns null rather than NaN', () => {
    expect(ev('int("42")')).toBe(42);
    expect(ev('int("4.9")')).toBe(4);
    expect(ev('int("abc")')).toBe(null);
    expect(ev('int("")')).toBe(null);
    expect(ev('float("1.5")')).toBe(1.5);
    expect(ev('float("nope")')).toBe(null);
  });

  it('json parses and returns null on malformed input', () => {
    expect(ev('json("{\\"a\\":1}")')).toEqual({ a: 1 });
    expect(ev('json("not json")')).toBe(null);
  });

  it('coalesce and default', () => {
    expect(ev('coalesce(steps.nope.x, vars.threshold)', scope)).toBe(10);
    expect(ev('default("", "fallback")')).toBe('fallback');
    expect(ev('default("set", "fallback")')).toBe('set');
    expect(ev('default(steps.nope.x, 7)', scope)).toBe(7);
  });

  it('math helpers', () => {
    expect(ev('abs(-3)')).toBe(3);
    expect(ev('round(2.6)')).toBe(3);
    expect(ev('min(3, 1, 2)')).toBe(1);
    expect(ev('max(3, 1, 2)')).toBe(3);
  });

  it('now() is fixed within one evaluation', () => {
    expect(ev('now()')).toBe(FIXED_NOW);
    expect(ev('now() == now()')).toBe(true);
    expect(ev('iso()')).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('reports an unknown function', () => {
    try {
      ev('nope(1)');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.UNKNOWN_FUNCTION);
    }
  });

  it('reports bad arity', () => {
    try {
      ev('len()');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.BAD_ARITY);
    }
  });
});

describe('truthiness', () => {
  it.each<[string, boolean]>([
    ['0', false],
    ['1', true],
    ['""', false],
    ['"x"', true],
    ['null', false],
    ['true', true],
    ['false', false],
  ])('evaluateBoolean(%s) === %s', (src, want) => {
    expect(evaluateBoolean(src, {})).toBe(want);
  });

  it('empty array is falsy, non-empty is truthy', () => {
    expect(evaluateBoolean('x', { x: [] })).toBe(false);
    expect(evaluateBoolean('x', { x: [1] })).toBe(true);
  });

  it('a missing path is falsy', () => {
    expect(evaluateBoolean('steps.nope.output.ok', scope)).toBe(false);
  });
});

describe('evaluation budget', () => {
  it('rejects an expression exceeding the node budget', () => {
    const src = Array.from({ length: 200 }, (_, i) => String(i)).join(' + ');
    try {
      evaluate(parse(src), {}, { limits: { ...({} as never), maxNodes: 10, maxRegexInput: 100, maxRegexPattern: 100, maxIterations: 100 } });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.TOO_COMPLEX);
    }
  });

  it('rejects an over-long source string at parse time', () => {
    try {
      parse('1 +'.repeat(2000) + '1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.TOO_COMPLEX);
    }
  });
});

describe('syntax errors', () => {
  it('gives a helpful message for a single =', () => {
    try {
      parse('a = 1');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as ExprError).message).toContain('==');
    }
  });

  it.each(['1 +', '(1', 'a.', 'a..b', '&& 1', 'a[1', ')'])('rejects %s', (src) => {
    expect(() => parse(src)).toThrow(ExprError);
  });

  it('validateExpression reports ok/not-ok without throwing', () => {
    expect(validateExpression('1 + 1')).toEqual({ ok: true });
    const bad = validateExpression('1 +');
    expect(bad.ok).toBe(false);
  });
});

describe('interpolateString', () => {
  it('preserves type for a sole placeholder', () => {
    expect(interpolateString('{{ steps.fetch.output.status }}', scope)).toBe(200);
    expect(interpolateString('{{ steps.fetch.output.body.ok }}', scope)).toBe(true);
    expect(interpolateString('{{ steps.fetch.output.body.items }}', scope)).toEqual([
      { id: 'a', qty: 2 },
      { id: 'b', qty: 0 },
    ]);
  });

  it('stringifies an embedded placeholder', () => {
    expect(interpolateString('status is {{ steps.fetch.output.status }}', scope)).toBe(
      'status is 200',
    );
  });

  it('handles several placeholders in one string', () => {
    expect(
      interpolateString('{{ vars.label }}/{{ steps.fetch.output.body.name }}', scope),
    ).toBe('prod/Feranmi');
  });

  it('leaves a string with no placeholder untouched', () => {
    expect(interpolateString('plain text', scope)).toBe('plain text');
  });

  it('is strict by default: a missing path throws', () => {
    expect(() => interpolateString('{{ steps.nope.output.x }}', scope)).toThrow(ExprError);
    try {
      interpolateString('{{ steps.nope.output.x }}', scope);
    } catch (e) {
      expect((e as ExprError).identity).toBe(EXPR_ERRORS.UNRESOLVED);
    }
  });

  it('can be made lenient explicitly', () => {
    expect(interpolateString('{{ steps.nope.x }}', scope, { strict: false })).toBeUndefined();
    expect(interpolateString('v={{ steps.nope.x }}', scope, { strict: false })).toBe('v=');
  });

  it('rejects an empty placeholder', () => {
    expect(() => interpolateString('{{ }}', scope)).toThrow(ExprError);
  });

  it('reports secret usage so the caller can redact', () => {
    const used: Array<[string, string]> = [];
    const out = interpolateString('Bearer {{ secrets.API_KEY }}', scope, {
      onSecretUsed: (n, v) => used.push([n, v]),
    });
    expect(out).toBe('Bearer sk_live_abc123');
    expect(used).toEqual([['API_KEY', 'sk_live_abc123']]);
  });

  it('evaluates expressions, not just paths', () => {
    expect(interpolateString('{{ steps.fetch.output.status == 200 }}', scope)).toBe(true);
    expect(interpolateString('{{ upper(vars.label) }}', scope)).toBe('PROD');
    expect(interpolateString('{{ vars.threshold * 2 }}', scope)).toBe(20);
  });
});

describe('interpolateValue', () => {
  it('walks nested objects and arrays', () => {
    const cfg: ExprValue = {
      url: 'https://api.test/{{ vars.label }}',
      headers: { 'X-Count': '{{ steps.fetch.output.body.count }}' },
      body: { n: '{{ steps.fetch.output.body.count }}', tags: ['{{ vars.label }}', 'static'] },
    };
    expect(interpolateValue(cfg, scope)).toEqual({
      url: 'https://api.test/prod', // embedded in a larger string -> stringified
      // A sole placeholder preserves type EVERYWHERE, including in a header value. Header values
      // must ultimately be strings, but that coercion belongs to the http step at send time, not
      // here: the interpolator's contract is "preserve the captured type", and weakening it for
      // one caller's convenience would silently turn every captured number into a string.
      headers: { 'X-Count': 42 },
      body: { n: 42, tags: ['prod', 'static'] },
    });
  });

  it('interpolates object keys too', () => {
    const cfg: ExprValue = { '{{ vars.label }}-key': 'v' };
    expect(interpolateValue(cfg, scope)).toEqual({ 'prod-key': 'v' });
  });

  it('leaves non-strings alone', () => {
    expect(interpolateValue({ a: 1, b: true, c: null }, scope)).toEqual({
      a: 1,
      b: true,
      c: null,
    });
  });

  it('caps nesting depth', () => {
    let deep: ExprValue = 'x';
    for (let i = 0; i < 80; i += 1) deep = { nested: deep };
    expect(() => interpolateValue(deep, scope)).toThrow(ExprError);
  });
});

describe('collectReferences / referenceRoot', () => {
  it('finds every placeholder without evaluating', () => {
    const cfg: ExprValue = {
      a: '{{ steps.one.output.x }}',
      b: ['{{ secrets.KEY }}', 'plain'],
      c: { '{{ vars.k }}': '{{ steps.two.output.y }}' },
    };
    expect([...collectReferences(cfg)].sort()).toEqual([
      'secrets.KEY',
      'steps.one.output.x',
      'steps.two.output.y',
      'vars.k',
    ]);
  });

  it('identifies the root and second segment of a plain path', () => {
    expect(referenceRoot('steps.fetch.output.x')).toEqual({ root: 'steps', second: 'fetch' });
    expect(referenceRoot('secrets.KEY')).toEqual({ root: 'secrets', second: 'KEY' });
    expect(referenceRoot('vars')).toEqual({ root: 'vars', second: null });
  });

  it('returns null for non-path expressions', () => {
    expect(referenceRoot('1 + 1')).toBe(null);
    expect(referenceRoot('len(x)')).toBe(null);
    expect(referenceRoot('not valid (')).toBe(null);
  });
});

describe('realistic branch conditions', () => {
  // The shapes an actual task would use, end to end.
  it.each<[string, boolean]>([
    ['steps.fetch.output.status == 200', true],
    ['steps.fetch.output.status >= 200 && steps.fetch.output.status < 300', true],
    ['steps.fetch.output.body.count > vars.threshold', true],
    ['steps.fetch.output.body.count > 100', false],
    ['len(steps.fetch.output.body.items) > 0', true],
    ['steps.fetch.output.body.name contains "eran"', true],
    ['steps.shell.output.exit_code != 0', false],
    ['lower(steps.fetch.output.body.name) == "feranmi"', true],
    ['steps.fetch.output.body.items[0].qty > 0 && steps.fetch.output.body.items[1].qty == 0', true],
    ['!steps.fetch.output.body.ok', false],
    ['coalesce(steps.nope.x, 0) == 0', true],
  ])('%s -> %s', (src, want) => {
    expect(evaluateBoolean(src, scope, { nowMs: FIXED_NOW })).toBe(want);
  });
});
