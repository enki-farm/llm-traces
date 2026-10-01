// Unit tests for Prism TraceQL grammar compatibility
// Run with: node --experimental-strip-types tests/prism-traceql.unit.test.ts
//
// Validates that the LLM filter query can be tokenised by Grafana's built-in
// Prism TraceQL grammar so attribute names appear in colour.
//
// Grammar source: extracted from Grafana Tempo plugin module.js
//
// Key patterns from the grammar:
//   filter (span-set inside):
//     /([\w:.\/-]+)\s*(=|!=|<=|>=|=~|!~|>|<)\s*("[^"]*"|[\w.\/-]+)
//       (\s*(&&|\|\|)\s*([\w:.\/-]+)\s*(op)\s*(value))*/g
//
//   label-key  → alias "attr-name"  (blue):
//     /[a-z_.][\\w./_-]*(:[\\w./_-]+)?(?=\s*(=|!=|>|<|>=|<=|=~|!~))/
//
//   label-value → alias "attr-value" (green):
//     /("(?:\\.|[^\\"])*")|(\w+)/
//
// How Prism tokenises a span-set body:
//   Prism's exec() loop is NOT anchored — it searches from position 0 and
//   returns the first match found anywhere in the remaining text.  So:
//   - body = 'span.foo != ""'           → match index 0 (perfect, `span.foo` → attr-name)
//   - body = '(span.foo != "")'         → match index 1 (the `(` is plain text; the
//                                          rest is still coloured, but `(` and `)` are
//                                          left as uncoloured plain text — visually ugly)
//   - body = 'span.foo =~ \\.\\*'       → NO MATCH (backslash not in value char-class;
//                                          known grammar limitation — pre-existing, not a
//                                          regression introduced by our changes)

// ---------------------------------------------------------------------------
// Minimal assertion helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
  } else {
    console.log(`  pass: ${message}`);
    passed++;
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  pass: ${message}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Prism TraceQL grammar patterns (extracted from Grafana Tempo module.js)
// ---------------------------------------------------------------------------

// The filter pattern inside a {span-set}.
// Uses the `g` flag — Prism's exec() loop finds the first match anywhere in
// the body string (not anchored to start).
const FILTER_PATTERN =
  /([\w:.\/-]+)\s*(=|!=|<=|>=|=~|!~|>|<)\s*("[^"]*"|[\w.\/-]+)(\s*(&&|\|\|)\s*([\w:.\/-]+)\s*(=|!=|<=|>=|=~|!~|>|<)\s*("[^"]*"|[\w.\/-]+))*/g;

// attr-name alias (renders in blue): lookahead for comparison operator
const ATTR_NAME_PATTERN =
  /[a-z_.][\w./_-]*(:[\\w./_-]+)?(?=\s*(=|!=|>|<|>=|<=|=~|!~))/g;

// attr-value alias (renders in green)
const ATTR_VALUE_PATTERN = /("(?:\\.|[^\\"])*")|(\w+)/g;

// ---------------------------------------------------------------------------
// LLM filter conditions (kept in sync with src/pages/TraceExplorer.tsx)
// ---------------------------------------------------------------------------

const LLM_FILTER_CONDITIONS =
  'span.gen_ai.operation.name != "" || span.gen_ai.provider.name != "" || span.gen_ai.system != ""';

const STANDALONE_QUERY = `{${LLM_FILTER_CONDITIONS}}`;
const STANDALONE_BODY  = LLM_FILTER_CONDITIONS; // content between { }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== Prism TraceQL grammar — coloring schema tests ===\n');

// --- Filter pattern: matching behaviour ---

// 1. Standalone LLM query body — filter pattern must match starting at index 0
//    so the very first character of every attribute name gets a colour token.
FILTER_PATTERN.lastIndex = 0;
const standaloneMatch = FILTER_PATTERN.exec(STANDALONE_BODY);
assertEquals(
  standaloneMatch?.index ?? -1,
  0,
  'filter pattern matches standalone LLM body at index 0 (first char → attr-name)'
);

// 2. Confirm the match covers the first attribute name
assert(
  (standaloneMatch?.[0] ?? '').startsWith('span.gen_ai.operation.name'),
  'filter match begins with the first LLM attribute name'
);

// 3. The standalone query must NOT start with "{(" — that would push the
//    first filter match to index 1, leaving a plain-text "(" before the
//    first coloured token (BUG-040 regression guard).
assert(
  !STANDALONE_QUERY.match(/^\{\s*\(/),
  'Standalone query must not start with "{(" (BUG-040 regression guard)'
);

// 4. With outer parens the filter still matches — but only at index 1.
//    This confirms the cosmetic regression: a leading "(" is left as plain
//    white text when it shouldn't be.
const bodyWithParens = `(${LLM_FILTER_CONDITIONS})`;
FILTER_PATTERN.lastIndex = 0;
const parenMatch = FILTER_PATTERN.exec(bodyWithParens);
assertEquals(
  parenMatch?.index ?? -1,
  1,
  'With outer parens, filter only matches at index 1 (leading "(" is plain text — regression)'
);

// --- attr-name pattern ---

// 5. Each LLM filter attribute must be recognised as an attr-name token.
const LLM_ATTRS = [
  'span.gen_ai.operation.name',
  'span.gen_ai.provider.name',
  'span.gen_ai.system',
];
for (const attr of LLM_ATTRS) {
  ATTR_NAME_PATTERN.lastIndex = 0;
  const m = ATTR_NAME_PATTERN.exec(`${attr} != ""`);
  assert(
    m !== null && m.index === 0,
    `attr-name pattern matches "${attr}" at index 0 (will render blue)`
  );
}

// 6. attr-name must NOT match a bare identifier with no following operator.
ATTR_NAME_PATTERN.lastIndex = 0;
assert(
  !ATTR_NAME_PATTERN.test('span.foo'),
  'attr-name pattern rejects a bare name with no following comparison operator'
);

// --- attr-value pattern ---

// 7. Quoted empty string (our LLM filter uses `!= ""`)
ATTR_VALUE_PATTERN.lastIndex = 0;
const emptyQuotedMatch = ATTR_VALUE_PATTERN.exec('""');
assert(emptyQuotedMatch !== null, 'attr-value pattern matches ""');

// 8. Non-empty quoted string
ATTR_VALUE_PATTERN.lastIndex = 0;
assert(ATTR_VALUE_PATTERN.test('"my-service"'), 'attr-value pattern matches "my-service"');

// 9. Bare word value
ATTR_VALUE_PATTERN.lastIndex = 0;
assert(ATTR_VALUE_PATTERN.test('200'), 'attr-value pattern matches bare integer');

// --- Known grammar limitation (pre-existing, not introduced by our commits) ---

// 10. Regex values with backslashes (e.g. Tempo's "=~ \\.*") CANNOT be tokenised
//     by Prism because backslash is not in the value char-class [\w.\/-].
//     This is a known limitation of the grammar — not a regression.
FILTER_PATTERN.lastIndex = 0;
const regexValMatch = FILTER_PATTERN.exec('span.foo =~ \\.\\*');
assert(
  regexValMatch === null,
  'Known limitation: filter pattern cannot tokenise regex values with backslashes (pre-existing)'
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) { process.exit(1); }
