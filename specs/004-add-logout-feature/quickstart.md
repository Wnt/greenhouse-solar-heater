# Quickstart: Add Logout Feature

**Feature**: 004-add-logout-feature

## Prerequisites

- Node.js 20 LTS
- Project dependencies installed (`npm install`)

## Development

1. Start the PoC server in auth-enabled mode:
   ```bash
   AUTH_ENABLED=true RPID=localhost ORIGIN=http://localhost:3000 node poc/server.js
   ```

2. Or in local mode (no auth, logout button hidden):
   ```bash
   node poc/server.js
   ```

3. Open `http://localhost:3000` in a browser.

## Testing

```bash
# Run unit tests (includes auth tests)
npm run test:unit

# Run e2e tests (includes logout flow)
npm run test:e2e

# Run all tests
npm test
```

## Files Changed

| File | Change |
|------|--------|
| `poc/index.html` | Add logout button to header nav |
| `poc/js/app.js` | Add auth status check on init + logout click handler |
| `poc/css/style.css` | Add logout button styles (if distinct from nav links) |
| `poc/server.js` | Potentially add `/auth/status` route for non-auth mode (if needed) |
| `tests/auth.test.js` | Add logout endpoint test cases |
| `tests/e2e/` | Add logout e2e test |
