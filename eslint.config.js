// ESLint flat config — sane defaults for this repo.
//
// The codebase mixes three runtimes with different dialects:
//   - server/**                CommonJS on Node 22
//   - playground/js/**         ES modules in the browser
//   - shelly/{control,control-logic,telemetry,watchdogs-meta}.js
//                              ES5 on Shelly's Espruino (see shelly/lint/
//                              for platform-conformance rules — this config
//                              only enforces generic code-quality ones)
//
// Scripts (*.mjs), tests (node:test + Playwright), and standalone playground
// HTML pages (sw.js, public/login.js) each get their own override block.

const js = require('@eslint/js');
const globals = require('globals');

// Rules applied to everything, on top of @eslint/js recommended.
const commonRules = {
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  // `warn` keeps the editor squiggle yellow rather than red so authors
  // can see in-progress identifiers without the editor screaming at
  // them, but the npm script runs with --max-warnings=0 so CI fails on
  // any survivor. Use a leading underscore (`_foo`) when an arg is
  // intentionally unused.
  'no-unused-vars': [
    'warn',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'none',
      ignoreRestSiblings: true,
    },
  ],
  'no-implicit-globals': 'error',
  'no-undef-init': 'error',
  'no-useless-concat': 'error',
  'no-useless-rename': 'error',
  'no-throw-literal': 'error',
  'no-return-await': 'error',
  'no-self-compare': 'error',
  'no-unneeded-ternary': 'error',
  'dot-notation': 'error',
  // Only enforce shorthand for properties (`{ foo }` instead of `{ foo: foo }`).
  // Rewriting method-valued props (`{ S3Client: function(){} }` → `{ S3Client(){} }`)
  // breaks constructor mocks — method shorthand forms are not constructable, and
  // tests that call `new S3Client()` on a patched module throw "X is not a
  // constructor" after the rewrite.
  'object-shorthand': ['error', 'properties'],
  'prefer-template': 'off',
  // Allow console.* — the server logs to stdout/stderr and the
  // playground uses console for dev diagnostics.
  'no-console': 'off',
  // Empty catch blocks are a deliberate pattern in this codebase for
  // optional APIs (navigator.vibrate) and on-device defensive code
  // (MQTT.unsubscribe during shutdown).
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-empty-function': 'off',
};

module.exports = [
  {
    // Global ignores — vendored code, generated artefacts, build/test output,
    // and nested projects with their own tooling.
    ignores: [
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'tests/output/**',
      'playground/vendor/**',
      'playground/public/qrcode-generator.mjs',
      'playground/public/simplewebauthn-browser.mjs',
      'playground/assets/**',
      // Runtime copy of shelly/ (and system.yaml) staged under playground/
      // for GitHub Pages compatibility. Gitignored; lint the source, not
      // the copy. See .gitignore "Copied runtime deps for playground".
      'playground/shelly/**',
      'playground/system.yaml',
      'shelly/lint/**',
      'deploy/**',
      'design/**',
    ],
  },

  js.configs.recommended,

  // Baseline for everything we don't override below. Most repo code targets
  // modern JS; narrower overrides tighten or loosen per runtime.
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: commonRules,
  },

  // Node CommonJS — server/, scripts/*.js, and most root-level *.js files.
  // (The `playwright*.config.js` files are ES modules — they override this
  // rule further down.)
  {
    files: ['server/**/*.js', '*.js', 'scripts/**/*.js', 'tests/e2e/_setup/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  // Node ESM — *.mjs scripts and tests.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },

  // Node scripts that launch a browser via Playwright and push most of
  // their code through `page.evaluate(...)` (runs in the page). The static
  // analyser can't tell which callback runs where, so make browser globals
  // available file-wide to avoid spurious no-undef reports.
  {
    files: ['scripts/generate-liquid-glass.mjs', 'scripts/make-icons.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },

  // Playground browser code (ES modules loaded by <script type="module">).
  {
    files: ['playground/js/**/*.js', 'playground/public/login.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Chart.js is loaded as a UMD global via <script> in index.html.
        Chart: 'readonly',
      },
    },
  },

  // Playground service worker — browser module with ServiceWorker globals.
  {
    files: ['playground/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.serviceworker,
      },
    },
  },

  // Shelly device scripts — ES5 on Espruino. `shelly/lint/` enforces the
  // platform-specific bans (class, async/await, array methods, etc.); here
  // we just turn off rules that conflict with the ES5 dialect.
  {
    files: [
      'shelly/control.js',
      'shelly/control-logic.js',
      'shelly/watchdogs-meta.js',
    ],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        // Espruino / Shelly runtime globals.
        Shelly: 'readonly',
        MQTT: 'readonly',
        HTTPServer: 'readonly',
        Timer: 'readonly',
        BLE: 'readonly',
        Virtual: 'readonly',
        Script: 'readonly',
        print: 'readonly',
        console: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        // Shared across playground + device via the CommonJS shim; see
        // playground/js/control-logic-loader.js.
        module: 'readonly',
        exports: 'writable',
      },
    },
    rules: {
      ...commonRules,
      'no-var': 'off',
      'prefer-const': 'off',
      'object-shorthand': 'off',
      // Shelly scripts are literally supposed to declare globals (they
      // run as top-level scripts on the device), so `no-implicit-globals`
      // does not apply.
      'no-implicit-globals': 'off',
      // `var` hoists to function scope on ES5, so a branch-local `var x`
      // after an early-return followed by another `var x` is legal and
      // idiomatic — not a bug.
      'no-redeclare': 'off',
      // `deploy.sh` concatenates control-logic.js + watchdogs-meta.js +
      // control.js into a single on-device script, so cross-file
      // references (MODES, EA_PUMP, evaluate, etc.) are resolved at
      // deploy time. ESLint, linting each file in isolation, can't see
      // that — the bespoke `shelly/lint/` pass handles Shelly-specific
      // correctness on the merged script.
      'no-undef': 'off',
    },
  },

  // Node tests (node:test) and their helpers. CommonJS for *.js, ESM for
  // *.mjs — everything under tests/ except the Playwright suites below.
  {
    files: ['tests/**/*.js'],
    ignores: ['tests/frontend/**', 'tests/e2e/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['tests/**/*.mjs'],
    ignores: ['tests/frontend/**', 'tests/e2e/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },

  // Playwright specs (frontend + e2e) run in Node but navigate a browser
  // via `page.evaluate(...)`, which takes a function that executes in the
  // page context and so references browser globals.
  {
    files: ['tests/frontend/**/*.js', 'tests/e2e/**/*.js', 'tests/e2e/**/*.spec.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Playwright fixture signatures require a destructuring pattern
      // (`async ({}, use) => ...`) even when no fixtures are consumed.
      'no-empty-pattern': 'off',
    },
  },

  // Playwright config files at the repo root. They use `import` syntax
  // — Playwright/Node resolves them as ES modules even though they carry
  // a .js extension (no "type" field in root package.json).
  {
    files: ['playwright*.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
];
