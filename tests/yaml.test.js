import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, parseFrontmatter, YamlError } from '../src/yaml.js';

test('parses nested mappings, sequences and scalar types', () => {
  const doc = parse(`
# comment
name: software-engineer   # trailing comment
version: "1.0"
count: 3
ratio: 0.5
on: true
nothing: null
tilde: ~
date: 2026-10-15
tags: [a, "b c", 3]
empty_list: []
empty_map: {}
nested:
  inner: value
  list:
    - one
    - two
compact:
- x
- y
items:
  - id: FACT-1
    evidence:
      - path: compose.yaml
        locator: services.db.image
  - id: FACT-2
    claim: 'it''s quoted'
`);
  assert.deepEqual(doc, {
    name: 'software-engineer',
    version: '1.0',
    count: 3,
    ratio: 0.5,
    on: true,
    nothing: null,
    tilde: null,
    date: '2026-10-15',
    tags: ['a', 'b c', 3],
    empty_list: [],
    empty_map: {},
    nested: { inner: 'value', list: ['one', 'two'] },
    compact: ['x', 'y'],
    items: [
      { id: 'FACT-1', evidence: [{ path: 'compose.yaml', locator: 'services.db.image' }] },
      { id: 'FACT-2', claim: "it's quoted" },
    ],
  });
});

test('block scalars honour style and chomping', () => {
  const doc = parse(`literal: |
  line one
  line two
strip: |-
  a
  b
folded: >
  folded
  text

  new para
keep: |+
  k

after: done
`);
  assert.equal(doc.literal, 'line one\nline two\n');
  assert.equal(doc.strip, 'a\nb');
  assert.equal(doc.folded, 'folded text\nnew para\n');
  assert.equal(doc.keep, 'k\n\n');
  assert.equal(doc.after, 'done');
});

test('multi-line plain and quoted scalars fold to one line', () => {
  const doc = parse(`description: Plans, implements and verifies
  scoped software changes.
quoted: "first
  second"
next: ok
`);
  assert.equal(doc.description, 'Plans, implements and verifies scoped software changes.');
  assert.equal(doc.quoted, 'first second');
  assert.equal(doc.next, 'ok');
});

test('apostrophes inside flow plain scalars are not quotes', () => {
  assert.deepEqual(parse("t: [doesn't work, what's new, 'quoted, item']"), { t: ["doesn't work", "what's new", 'quoted, item'] });
});

test('double-quoted escapes decode', () => {
  assert.deepEqual(parse('a: "tab\\there \\u00e9 \\"q\\""'), { a: 'tab\there é "q"' });
});

test('rejects unsupported or ambiguous YAML loudly', () => {
  const bad = [
    ['a: &anchor 1', /anchors/],
    ['a: *alias', /anchors/],
    ['a: !tag x', /tags/],
    ['a: 1\na: 2', /duplicate key/],
    ['a:\n\tb: 1', /tabs/],
    ['a: 1\n---\nb: 2', /multiple documents/],
    ['description: Use when: foo', /quote the value/],
    ['a: @x', /cannot start/],
    ['? complex\n: v', /complex keys/],
    ['a:\n  b: 1\n c: 2', /indentation|expected/],
  ];
  for (const [src, re] of bad) {
    assert.throws(() => parse(src), (e) => e instanceof YamlError && re.test(e.message), `should reject: ${JSON.stringify(src)}`);
  }
});

test('frontmatter extraction', () => {
  const fm = parseFrontmatter('---\nname: x\ndescription: "Does y. Use when z."\n---\n# Body\n');
  assert.equal(fm.error, null);
  assert.deepEqual(fm.data, { name: 'x', description: 'Does y. Use when z.' });
  assert.equal(fm.body, '# Body\n');
  assert.match(parseFrontmatter('# no fm').error, /missing/);
  assert.match(parseFrontmatter('---\nname: x\n').error, /unterminated/);
});

test('stringify round-trips through parse', () => {
  const samples = [
    { a: 'plain', b: 'needs: quote', c: 'true', d: '123', e: '', f: ' padded ', g: 'multi\nline\n\ntext', h: '#hash', i: "it's", j: 'x #y' },
    { list: [1, 2.5, true, null, 'str', { k: 'v', nested: [{ deep: ['x'] }] }, [], {}] },
    { unicode: 'é ü 中文', ctrl: 'a\tb', backslash: 'C:\\path', url: 'https://example.invalid/a?b=c#d' },
    [{ id: 'FACT-0001', evidence: [{ path: 'package.json', sha256: 'abc' }] }],
    { 'weird key': 1, 'key:colon': 2, '123': 3, null: 'k' },
    { emptyStr: '', nul: null, inf: Infinity, ninf: -Infinity },
  ];
  for (const s of samples) {
    const text = stringify(s);
    assert.deepEqual(parse(text), s, `round trip failed for:\n${text}`);
  }
});

test('stringify emits header comments', () => {
  const text = stringify({ a: 1 }, { header: 'Generated file\n\nDo not edit' });
  assert.match(text, /^# Generated file\n#\n# Do not edit\na: 1\n$/);
});
