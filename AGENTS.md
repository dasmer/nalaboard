# Burntboard

- Work in isolated worktrees and preserve unrelated changes.
- Use the InsForge skills before database, SDK, storage, or compute changes.
- This app owns its email OTP and opaque sessions. It does not use InsForge built-in user authentication. Only the Node server holds an InsForge admin key; browser and agents use the app API.
- Keep credentials in ignored .env.local / .insforge files. Never print codes, keys, or email bodies in logs.
- Integration fixtures belong only in the linked burntboard-test or burntboard-series-test project. Never seed production or import legacy JSON.
- Run npm test for local checks and npm run test:integration against the isolated test server for backend changes.
- No administrator features. Do not merge or deploy without explicit user authorization.
