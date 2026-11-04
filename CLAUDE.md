# Burntboard — Claude Code Context

Read [AGENTS.md](AGENTS.md) for repository development instructions and [README.md](README.md) for architecture, testing, and releases.

Burntboard is a Node app backed by InsForge, with first-party email login. Players use the website or their personal agent connection to record games and edit profiles. GitHub identity, JSON edits, and pull requests are not the player workflow.

For player actions, install the skill from the website's Agents section. The canonical contract is [skills/burntboard/SKILL.md](skills/burntboard/SKILL.md), also served at `/agent.md`. Use the app API with the user's personal key; never use infrastructure credentials or impersonate another player. Ask for missing results rather than inventing scores.

Games are best of three matches. Exact finishes are 11–0 through 11–9. Deuce and forgotten-score results store who won without numerical scores. Winner slots follow the original player order, including corrections. The API enforces authorization, idempotency, and revision checks; corrections retain history.

For code changes, use an isolated worktree and run `npm test`. Backend changes also need the isolated integration suite described in README. Keep production free of fixtures. Do not merge or deploy without explicit user authorization.
