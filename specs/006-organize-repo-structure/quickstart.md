# Quickstart: Verify Repository Reorganization

**Feature**: 006-organize-repo-structure
**Date**: 2026-03-21

## Verification Steps

After the reorganization is complete, verify everything works:

### 1. Check Directory Structure

```bash
# Should show 6 unit directories + root files
ls -d */
# Expected: deploy/  design/  monitor/  playground/  shelly/  tests/
# Plus: specs/  .github/  .specify/  .claude/  node_modules/
```

### 2. Run Tests

```bash
# All tests must pass
npm test

# Or run unit tests only (faster)
npm run test:unit
```

### 3. Verify Cross-References

```bash
# No remaining references to old directory names in source files
grep -r '"../scripts/' tests/          # should return nothing
grep -r '"../poc/' tests/              # should return nothing
grep -r 'poc/' deploy/                 # should return nothing (except comments/docs)
grep -r 'scripts/' .github/workflows/  # should reference shelly/, not scripts/
```

### 4. Verify Docker Build

```bash
# App image should build successfully
docker build -f deploy/docker/Dockerfile -t test-app .
```

### 5. Verify Shelly Linter

```bash
# Linter should find scripts at new paths
cd shelly/lint && npm install && cd ../..
node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js --config system.yaml
```

### 6. Check Documentation

```bash
# CLAUDE.md should not reference old paths
grep -E '(scripts/|tools/|poc/|docs/|diagrams/|construction/|existing-hardware/)' CLAUDE.md
# Should return nothing (all updated to new paths)
```
