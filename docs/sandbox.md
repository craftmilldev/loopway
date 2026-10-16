# Sandbox: legitimate bot work

Claude bots run in a sandbox (`packages/harnesses/src/sandbox.ts`, applied in `claude.ts`). The default policy has to let
normal bot work through, so most users never need `--no-sandbox`. This is the list of work that must pass, and how each
row is checked.

| Action | What it needs | Check |
| --- | --- | --- |
| Edit/Write in the working directory | cwd is writable | unit test (`legitimate work passes`) |
| Create and use a git worktree (`.claude/worktrees/...`) | cwd writable; the shared git dir when the cwd is itself a worktree (resolved with `git rev-parse --git-common-dir`) | unit test + manual |
| `npm ci`, repo tests | `~/.npm` (or `$npm_config_cache`), `~/.cache`, `~/Library/Caches`, `~/.node-gyp`, temp | unit test |
| `git commit`, `git push` | cwd's git dir; global git config is read-only and readable | manual |
| `gh` calls (issues, PRs, API) | network open; auth through the environment (`GH_TOKEN`) and a Loopway-owned config dir (`GH_CONFIG_DIR=~/.loopway/gh`), since `~/.config/gh` stays unreadable | unit test (`botEnv`, `legitimate work passes`) + manual |
| `loopway` CLI, `git ls-remote`, `npm view` (any host) | the sandbox's `httpProxyPort` is our open proxy (`open-proxy.ts`; Claude's own proxy rejects `allowedDomains: ["*"]`), and `NODE_USE_ENV_PROXY=1` makes Node's `fetch` use it (without it: `ENOTFOUND`) | unit test (settings, env, proxy) + manual |
| loopway MCP tools | network (local MCP endpoint) | manual |
| Tools that keep data or state | `~/.local/share`, `~/.local/state`, `$XDG_*_HOME` | unit test |
| Claude's own session files | `~/.claude` (but not its settings, hooks, skills, commands, agents, plugins) | unit test |

Must still fail: reading `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.netrc`; writing anywhere else in `$HOME`
(including `~/.config`); writing Claude's or loopway's settings. Unit tests cover these too.

Paths that depend on the machine are resolved when a run starts (`sandboxPolicy()`): temp, the shared git dir, and any
cache the environment moves (`npm_config_cache`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`).

## Manual check (needs a real Claude run)

In a scratch clone, with the sandbox on (the default), run a bot against an issue and confirm the session can: enter a
worktree, `npm ci`, run the tests, commit, push, `gh pr create`, and call `link` and `end`. Also have it run
`gh auth status`, `loopway messages get ...` (no `ENOTFOUND`), `git ls-remote origin` and `npm view left-pad version`;
all must work. Then ask it to `cat ~/.ssh/config`, `cat ~/.config/gh/hosts.yml` and `touch ~/x`; all must fail.

## Diagnosing a denial

When a sandboxed run has tool results that look like denials (`Operation not permitted`, `Read-only file system`, or the
write guard's message), the session log gets a `SANDBOX:` note listing them and pointing at `--no-sandbox`. The
`bot_sandbox_denied` metric counts those sessions.
