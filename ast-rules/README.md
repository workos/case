# AST-Grep Rules

Structural lint rules for enforcing conventions via AST pattern matching. Rules are YAML files processed by [ast-grep](https://ast-grep.github.io/).

## Directory Structure

```
ast-rules/
├── target/          # Rules for target repos (run by implementer before committing)
│   ├── no-require.yml
│   ├── no-default-export.yml
│   └── no-console-log.yml
└── self/            # Rules for case's own codebase (run in CI / pre-commit)
    ├── no-hardcoded-paths.yml
    ├── no-direct-taskjson-write.yml
    └── no-macos-open.yml
```

## Target Repo Rules

Rules that enforce golden principles across WorkOS open source repos. The implementer agent runs these before committing.

| Rule                | Severity | Rationale                                                                                                   |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `no-require`        | error    | Enforce ESM imports. `require()` breaks tree-shaking and is banned per golden-principles.md #4.             |
| `no-default-export` | error    | Enforce named exports for consistent import patterns across repos. Default exports create ambiguous naming. |
| `no-console-log`    | warning  | Enforce structured logger usage. `console.error` and `console.warn` are allowed for CLI output.             |

## Self-Enforcement Rules

Rules that enforce case's own codebase invariants, inspired by mill's ast-grep discipline.

| Rule                       | Severity | Rationale                                                                                                                       |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `no-hardcoded-paths`       | error    | Catch `/Users/` literals in TypeScript. Hardcoded absolute paths are non-portable.                                              |
| `no-direct-taskjson-write` | error    | `.task.json` must be written through `TaskStore`, not via direct `writeFile`/`writeFileSync`. `task-store*` files are excluded. |
| `no-macos-open`            | warning  | Catch `Bun.spawn(['open', ...])` — macOS-only. Use cross-platform opener or platform guard.                                     |

## Usage

```bash
# Run target rules against current directory
bun run lint:ast

# Run self-enforcement rules against src/
bun run lint:ast:self

# Run all rules
bun run lint:ast:all

# Run test fixtures
bun run test:ast
```

## Implementation Notes

### `no-hardcoded-paths` uses `kind: string_fragment`

ast-grep's tree-sitter TypeScript parser represents the inner text of a string (without quotes) as `string_fragment`. Using `kind: string` would match the entire string node including quotes, which makes regex matching unreliable. `string_fragment` matches only the content.

This rule only scans TypeScript files. Existing hardcoded paths in `.sh` and `.md` files are outside ast-grep's scope — use `grep -r '/Users/' scripts/ agents/` to find those.

### `no-direct-taskjson-write` uses top-level `regex`

The spec described using `constraints` and `inside.not.has.pattern` for file-scope exclusion. ast-grep's `constraints` + `inside` syntax proved unreliable for this pattern. The implementation uses top-level `regex: 'task\.json'` (matches against the entire matched node's text) combined with `ignores:` globs to exclude `task-store*` and test files. This is more robust and achieves the same goal.

## Adding New Rules

1. Create a YAML file in the appropriate directory (`target/` or `self/`)
2. Add violation and clean fixtures in `tests/ast-rules/fixtures/`
3. Run `bun run test:ast` to verify
4. Update this README with the rule's rationale
