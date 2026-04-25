const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const myYaml = require('../scripts/lib/yaml-load.js');

describe('yaml-load (in-tree)', () => {
  it('parses primitive scalars', () => {
    assert.deepStrictEqual(myYaml.load('a: 1\nb: 2.5\nc: true\nd: null\ne: hello'),
      { a: 1, b: 2.5, c: true, d: null, e: 'hello' });
  });

  it('parses block sequences', () => {
    assert.deepStrictEqual(myYaml.load('items:\n  - one\n  - two\n  - 3'),
      { items: ['one', 'two', 3] });
  });

  it('parses nested mappings', () => {
    assert.deepStrictEqual(myYaml.load('a:\n  b:\n    c: deep'),
      { a: { b: { c: 'deep' } } });
  });

  it('parses flow sequences and flow mappings', () => {
    assert.deepStrictEqual(myYaml.load('p: [1, 2, 3]\nq: {x: 10, y: 20}'),
      { p: [1, 2, 3], q: { x: 10, y: 20 } });
  });

  it('parses double-quoted strings with escapes', () => {
    assert.deepStrictEqual(myYaml.load('s: "a\\nb\\tc"'),
      { s: 'a\nb\tc' });
  });

  it('parses single-quoted strings with doubled-quote escape', () => {
    assert.deepStrictEqual(myYaml.load("s: 'it''s'"),
      { s: "it's" });
  });

  it('parses folded block scalars (>) with trailing newline', () => {
    const text = 'note: >\n  one two\n  three\n';
    assert.strictEqual(myYaml.load(text).note, 'one two three\n');
  });

  it('parses folded block scalars with strip chomping (>-)', () => {
    const text = 'note: >-\n  one\n  two\n';
    assert.strictEqual(myYaml.load(text).note, 'one two');
  });

  it('parses literal block scalars (|)', () => {
    const text = 'block: |\n  line one\n  line two\n';
    assert.strictEqual(myYaml.load(text).block, 'line one\nline two\n');
  });

  it('strips trailing comments outside quoted strings', () => {
    assert.deepStrictEqual(myYaml.load('a: 1  # comment\nb: "has # inside"'),
      { a: 1, b: 'has # inside' });
  });
});

// End-to-end checks against the real project YAML files. These guard
// against regressions in the parser by asserting specific values that
// downstream code (control-logic, topology generator, simulator) relies on.
describe('yaml-load on real project files', () => {
  const repoRoot = path.resolve(__dirname, '..');

  it('parses system.yaml and exposes expected structure', () => {
    const file = path.join(repoRoot, 'system.yaml');
    const data = myYaml.load(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(typeof data.project, 'object');
    assert.strictEqual(data.project.name, 'Greenhouse Solar Heating System');
    assert.strictEqual(typeof data.components, 'object');
    assert.strictEqual(typeof data.modes, 'object');
    // Folded scalars should fold consecutive lines into spaces.
    assert.ok(typeof data.components.tank.connections.note === 'string');
    assert.ok(!data.components.tank.connections.note.includes('\n        '));
  });

  it('parses topology-layout.yaml and preserves quoted hex-color keys', () => {
    const file = path.join(repoRoot, 'design', 'diagrams', 'topology-layout.yaml');
    const data = myYaml.load(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(typeof data.canvas, 'object');
    assert.strictEqual(data.canvas.width, 940);
    assert.strictEqual(typeof data.styles, 'object');
    // Quoted-key flow mapping in themes section.
    assert.strictEqual(data.themes.light.fill['#111111'], '#f5f5f5');
  });
});
