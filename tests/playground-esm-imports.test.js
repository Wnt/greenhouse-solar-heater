// Static import/export resolution check for playground ESM modules.
//
// Parses every `playground/js/**/*.js` file as ES module source, then
// for each `import { x, y as z } from '<relative>'` statement walks
// to the target file and confirms x and y are actually exported.
//
// Catches the class of bug where a sibling module imports a name
// that was never (or no longer) exported — the exact shape of the
// `controller` regression that the unit tests missed on 2026-04-22
// because Node unit tests don't load playground entry points.
//
// Runs in under a second; no browser, no serve, no playwright.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { execSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const PLAYGROUND_DIR = path.join(REPO_ROOT, 'playground');

// Parse `playground/js/**/*.js` (including subdirs) plus the root
// playground/*.js entry points (sw.js). Use git ls-files so the
// check scopes to tracked files only.
function listPlaygroundJsFiles() {
  // `-c safe.directory=*` — CI containers check out as a different
  // user than the one running node, so plain `git ls-files` refuses
  // with "fatal: detected dubious ownership".
  const out = execSync("git -c safe.directory='*' ls-files playground", { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean)
    .filter(p => p.endsWith('.js') || p.endsWith('.mjs'))
    // Skip third-party vendored files; their exports aren't our problem.
    .filter(p => !p.startsWith('playground/vendor/'))
    .filter(p => !p.startsWith('playground/public/'));
}

function parse(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  return acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  });
}

// Collect the set of names a module provides as named exports, plus a
// flag for whether it has a default export. Handles:
//   - export function name()
//   - export async function name()
//   - export class Name
//   - export const|let|var name = ...
//   - export { a, b as c }
//   - export { a } from './other.js'   (re-exports; followed recursively)
//   - export * from './other.js'       (re-exports; followed recursively)
//   - export default ...
function collectExports(filePath, visited = new Set()) {
  if (visited.has(filePath)) return { named: new Set(), hasDefault: false };
  visited.add(filePath);

  let ast;
  try { ast = parse(filePath); }
  catch (err) { throw new Error(`Failed to parse ${filePath}: ${err.message}`); }

  const named = new Set();
  let hasDefault = false;

  for (const node of ast.body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        const d = node.declaration;
        if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
          named.add(d.id.name);
        } else if (d.type === 'VariableDeclaration') {
          for (const decl of d.declarations) {
            if (decl.id.type === 'Identifier') named.add(decl.id.name);
          }
        }
      } else if (node.specifiers) {
        if (node.source) {
          // `export { a, b } from './other.js'` — follow the chain.
          const resolved = resolveImport(filePath, node.source.value);
          if (resolved) {
            const sub = collectExports(resolved, visited);
            for (const spec of node.specifiers) {
              if (spec.local.name === 'default') {
                if (sub.hasDefault) named.add(spec.exported.name);
              } else if (sub.named.has(spec.local.name)) {
                named.add(spec.exported.name);
              }
            }
          }
        } else {
          for (const spec of node.specifiers) {
            named.add(spec.exported.name);
          }
        }
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      hasDefault = true;
    } else if (node.type === 'ExportAllDeclaration') {
      const resolved = resolveImport(filePath, node.source.value);
      if (resolved) {
        const sub = collectExports(resolved, visited);
        for (const name of sub.named) named.add(name);
      }
    }
  }

  return { named, hasDefault };
}

// Collect this module's imports from relative-path siblings. Bare
// specifiers (e.g. 'qrcode-generator') resolve via importmap or npm
// and are skipped — this test only checks module-to-module wiring
// within the playground source tree.
function collectImports(filePath) {
  let ast;
  try { ast = parse(filePath); }
  catch (err) { throw new Error(`Failed to parse ${filePath}: ${err.message}`); }

  const imports = [];
  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const src = node.source.value;
    if (!src.startsWith('.') && !src.startsWith('/')) continue; // bare specifier
    const resolved = resolveImport(filePath, src);
    if (!resolved) continue; // could not resolve to a local file

    const named = [];
    let defaultBinding = null;
    let namespace = false;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportSpecifier') {
        named.push({ imported: spec.imported.name, local: spec.local.name });
      } else if (spec.type === 'ImportDefaultSpecifier') {
        defaultBinding = spec.local.name;
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        namespace = true;
      }
    }
    imports.push({ source: src, target: resolved, named, defaultBinding, namespace });
  }
  return imports;
}

function resolveImport(fromFile, spec) {
  const fromDir = path.dirname(fromFile);
  let candidate;
  if (spec.startsWith('/')) {
    // Absolute path (as served by the web server, anchored at playground/).
    candidate = path.join(PLAYGROUND_DIR, spec.replace(/^\//, ''));
  } else {
    candidate = path.join(fromDir, spec);
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  // Try adding .js / .mjs
  for (const ext of ['.js', '.mjs']) {
    if (fs.existsSync(candidate + ext)) return candidate + ext;
  }
  return null;
}

describe('playground ESM module graph', () => {
  const files = listPlaygroundJsFiles();

  it('every playground .js file parses as ES module', () => {
    const errors = [];
    for (const f of files) {
      try { parse(path.join(REPO_ROOT, f)); }
      catch (err) { errors.push(`${f}: ${err.message}`); }
    }
    assert.deepStrictEqual(errors, [], 'parse errors:\n' + errors.join('\n'));
  });

  it('no playground/js/main/* module imports from ../main.js', () => {
    // Architectural rule: sub-modules under playground/js/main/ MUST
    // NOT import from ../main.js. Shared mutable state lives in
    // ./main/state.js (a leaf module) and helpers live in their own
    // sibling modules; importing back from main.js forms a cycle and
    // invites the kind of circular-binding-not-yet-defined bugs we
    // hit before (e.g. `controller` undefined at module-init time).
    // main.js remains the entry-point / wiring module only.
    const violations = [];
    for (const f of files) {
      if (!f.startsWith('playground/js/main/')) continue;
      const imports = collectImports(path.join(REPO_ROOT, f));
      for (const imp of imports) {
        if (imp.source === '../main.js') {
          violations.push(
            `${f}: imports from '../main.js' — move shared state to ./state.js ` +
            `or refactor so main.js isn't a dependency of ./main/* modules.`
          );
        }
      }
    }
    assert.deepStrictEqual(violations, [], violations.join('\n'));
  });

  it('the module graph has no import cycles', () => {
    // Build a directed graph: for each file, the set of other files it
    // directly imports. Skip bare specifiers (external packages) and
    // unresolved imports — only in-tree edges form the graph.
    const graph = new Map();
    for (const f of files) {
      const fromPath = path.join(REPO_ROOT, f);
      let imports;
      try { imports = collectImports(fromPath); }
      catch { imports = []; }
      graph.set(path.resolve(fromPath), new Set(imports.map(i => path.resolve(i.target))));
    }

    // DFS — white/grey/black colouring. A back edge (to a grey node) is
    // a cycle; report the full loop path.
    const WHITE = 0, GREY = 1, BLACK = 2;
    const colour = new Map();
    const cycles = [];
    const stack = [];

    function visit(node) {
      colour.set(node, GREY);
      stack.push(node);
      for (const next of (graph.get(node) || [])) {
        if (colour.get(next) === GREY) {
          const start = stack.indexOf(next);
          cycles.push(stack.slice(start).concat(next).map(p => path.relative(REPO_ROOT, p)));
        } else if ((colour.get(next) || WHITE) === WHITE) {
          visit(next);
        }
      }
      stack.pop();
      colour.set(node, BLACK);
    }

    for (const node of graph.keys()) {
      if ((colour.get(node) || WHITE) === WHITE) visit(node);
    }

    assert.deepStrictEqual(
      cycles, [],
      'import cycles detected:\n  ' + cycles.map(c => c.join(' → ')).join('\n  ')
    );
  });

  it('every named import resolves to a matching export in the target module', () => {
    const errors = [];
    for (const f of files) {
      const fromPath = path.join(REPO_ROOT, f);
      let imports;
      try { imports = collectImports(fromPath); }
      catch (err) { errors.push(`${f}: ${err.message}`); continue; }

      for (const imp of imports) {
        if (imp.namespace) continue; // `import * as X` takes whatever the module exposes
        const { named } = collectExports(imp.target);
        const hasDefault = collectExports(imp.target).hasDefault;

        if (imp.defaultBinding && !hasDefault) {
          errors.push(`${f}: default import from ${imp.source} but target has no default export`);
        }
        for (const n of imp.named) {
          if (!named.has(n.imported)) {
            errors.push(
              `${f}: imports { ${n.imported} } from '${imp.source}' ` +
              `but ${path.relative(REPO_ROOT, imp.target)} does not export '${n.imported}'`
            );
          }
        }
      }
    }

    assert.deepStrictEqual(
      errors, [],
      'unresolved named imports:\n  ' + errors.join('\n  ')
    );
  });
});
