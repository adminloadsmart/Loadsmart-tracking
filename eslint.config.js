const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier');
const prettierPlugin = require('eslint-plugin-prettier');
const importPlugin = require('eslint-plugin-import');
const boundaries = require('eslint-plugin-boundaries');
const security = require('eslint-plugin-security');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'vitest.config.mts'] },

  js.configs.recommended,
  // NOTE: recommendedTypeChecked is intentionally NOT used here. typescript-eslint's
  // parser hard-refuses to even load against typescript@7.0.2 ("typescript-eslint does
  // not support TS 7.0") independent of type-checked rules — confirmed by running it.
  // `require('typescript')` is aliased in package.json to the official @typescript/typescript6
  // compatibility shim (see docs/linting-standard.md) precisely so the syntax-only parser
  // below can load at all; `typescript-native` (the real TS7 compiler) is what actually
  // builds/runs the app (see package.json "build" script). No parserOptions.project/
  // projectService is configured, so type-aware rules are unavailable until typescript-eslint
  // publishes TS7 support (tracked upstream in typescript-eslint issue #10940) — at which
  // point recommendedTypeChecked, no-floating-promises and no-misused-promises can return.
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    plugins: { import: importPlugin, prettier: prettierPlugin, boundaries, security },
    settings: {
      // Needed even without path aliases: ESLint's default Node resolver only checks
      // .mjs/.js/.json/.node by default and won't resolve bare relative `.ts` imports,
      // which would silently break import/no-cycle, import/order, etc.
      'import/resolver': { node: { extensions: ['.js', '.ts'] } },

      // eslint-plugin-boundaries v7 classifies a file across two independent dimensions:
      // its architectural *element* (a folder — here, a module) and its *file category*
      // (a role within that folder, via boundaries/files below). Role suffixes
      // (*.controller.ts, *.service.ts, ...) live as siblings inside one module folder in
      // this codebase, not in separate role subfolders, so role is modeled as a file
      // category, not as a nested element.
      'boundaries/elements': [
        { type: 'module', pattern: 'src/modules/*', capture: ['moduleName'] },
        { type: 'shared', pattern: 'src/shared' },
        { type: 'adapter', pattern: 'src/adapters' },
        { type: 'streams', pattern: 'src/streams' },
        { type: 'polling', pattern: 'src/polling' },
      ],
      'boundaries/files': [
        { category: 'entry', pattern: 'src/modules/*/index.ts' },
        { category: 'controller', pattern: 'src/modules/*/*.controller.ts' },
        { category: 'route', pattern: 'src/modules/*/*.routes.ts' },
        { category: 'service', pattern: 'src/modules/*/*.service.ts' },
        { category: 'repository', pattern: 'src/modules/*/*.repository.ts' },
        {
          category: 'entity',
          pattern: ['src/modules/*/*.entity.ts', 'src/modules/*/entities/*.entity.ts'],
        },
      ],
    },
    rules: {
      'prettier/prettier': 'error',

      // default: 'allow' + targeted 'disallow' policies, not the other way round. An
      // allowlist was tried first and reverted: this codebase has a lot of legitimate
      // cross-cutting traffic that isn't captured by the controller/service/repository/
      // entity/route/entry taxonomy at all — shared/ middleware calling into specific
      // modules' services and repositories (audit.middleware -> audit.service,
      // auth.middleware -> auth.repository), shared/openapi aggregating every module's
      // openapi doc, entities referencing sibling modules' entities for relations, and
      // ancillary per-module files (*.openapi.ts, *.validators.ts, utils/*.interface.ts)
      // that aren't classified as a file category at all. Under default: 'disallow' every
      // one of those real, working edges came back as an error (confirmed — ~46 false
      // positives on the very first run). default: 'allow' only blocks what this rule set
      // is actually meant to catch: a layer skipping the one below it.
      //
      // checkInternals: true is required — the whole point here is layering *within* one
      // module (controller/service/repository/entity all share the same 'module' element),
      // and this rule ignores same-element ("internal") dependencies entirely unless told
      // otherwise (confirmed: with it left at the default false, every policy below was a
      // silent no-op — the deliberate boundary-violation test in the verification section
      // wasn't caught until this was added).
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          checkInternals: true,
          policies: [
            {
              from: { file: { categories: 'controller' } },
              disallow: { file: { categories: 'repository' } },
              message: 'Controllers must go through a service, not import a repository directly.',
            },
            {
              from: { file: { categories: 'route' } },
              disallow: { file: { categories: ['service', 'repository'] } },
              message:
                'Routes must go through the controller, not import a service/repository directly.',
            },
            {
              from: { file: { categories: 'repository' } },
              disallow: { file: { categories: ['controller', 'service'] } },
              message: 'Repositories must not depend upward on controllers/services.',
            },
            {
              from: { file: { categories: 'entity' } },
              disallow: { file: { categories: ['controller', 'service', 'repository'] } },
              message: 'Entities must not depend upward on controllers/services/repositories.',
            },
          ],
        },
      ],
      // boundaries/no-private is deliberately NOT enabled: it's deprecated in this version
      // (eslint-plugin-boundaries says so at runtime) in favor of expressing privacy directly
      // as boundaries/dependencies policies, and it would be inert here anyway today (no
      // element type is nested inside another in this config).

      // @typescript-eslint/no-floating-promises and no-misused-promises are deliberately
      // OMITTED: both require type information (parserOptions.project/projectService),
      // which isn't available here — see the top-of-file note. Enabling either without
      // it makes ESLint crash outright (confirmed). Revisit alongside recommendedTypeChecked.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Global namespace augmentation (declare global { namespace Express { ... } }) is the
      // only way to extend a third-party ambient global like Express's Request — there's no
      // ES2015-module equivalent for that, so `declare`d namespaces are exempted.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],

      'import/no-cycle': 'error',
      'import/no-self-import': 'error',
      'import/no-duplicates': 'error',
      'import/no-useless-path-segments': 'error',
      // 'import/order' is OFF, not just tuned down: eslint-plugin-import 2.32.0's report
      // path (both the newlines-between check and the out-of-order check) calls SourceCode
      // methods ESLint 10 removed (`getTokenOrCommentAfter`/`Before`), which crash the whole
      // `eslint .` run outright the moment either violation is found (confirmed against two
      // separate files) — not a lint failure, a hard crash. Revisit once eslint-plugin-import
      // ships an ESLint 10-compatible release.
      // 'import/order': ['warn', { groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'] }],

      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'warn',
    },
  },

  {
    files: ['**/*.test.ts', '**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'boundaries/dependencies': 'off',
    },
  },

  // This file itself: plain Node CommonJS, not part of the src/**/*.ts TypeScript
  // program above, so it needs its own node globals and an exemption from the
  // TS-flavored "use import instead of require()" rule. Placed last so it wins over
  // the broader tseslint.configs.recommended entries above for this one file.
  {
    files: ['eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.commonjs } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  prettierConfig,
);
