# Contributing to claude-tools

## Development Setup

```bash
git clone https://github.com/seidnerj/claude-tools.git
cd claude-tools
npm install
pre-commit install --hook-type commit-msg --hook-type pre-commit
```

## Code Style

- Formatting is enforced by [prettier](https://prettier.io/) (printWidth=150, 4-space indent, double quotes)
- Linting via [ESLint](https://eslint.org/) with TypeScript rules
- Type-only imports enforced (`import type { ... }`)
- All imports at the top of the file (builtin, then external, then internal)

## Testing

Every change must include corresponding tests:

```bash
npx vitest run
```

Tests use [vitest](https://vitest.dev/). Tests live in `src/tests/`.

## Pre-commit Hooks

The following checks run automatically on commit:

- **prettier** - Code and config formatting
- **eslint** - TypeScript linting with auto-fix
- **tsc** - Type checking
- **vitest** - Test suite
- **trailing-whitespace** - Trim trailing whitespace
- **end-of-file-fixer** - Ensure files end with newline
- **mixed-line-ending** - Normalize to LF
- **detect-secrets** - Secret detection

Run all hooks manually:

```bash
pre-commit run --all-files
```

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes with tests
3. Ensure all pre-commit hooks pass
4. Submit a PR with a clear description of the change

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
