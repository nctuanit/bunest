## Summary

<!-- Describe what this PR changes and why. Link related issues (e.g. Closes #123). -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation / Examples
- [ ] Performance / Refactor
- [ ] CI / Build / Tooling

## Verification Checklist

- [ ] `bun run typecheck` passes with 0 errors
- [ ] `bun run build` passes
- [ ] `bun test` passes (and new behavior is covered by tests)
- [ ] `bun run conformance:gate` passes (no new skips)
- [ ] `bun run ai:docs --check` passes (ran `bun run ai:docs` if error codes or public exports changed)
- [ ] `bun run verify:release` passes (zero external runtime deps, no `node:*` imports, no circular runtime imports)
