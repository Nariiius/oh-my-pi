# Full setup guide — omp + AgentRouter gateway

From zero to a working omp that talks to AgentRouter. Everything is copy-pasteable.

Three things make up the setup:

1. **omp** — the agent (official binary, or this fork with extra tooling)
2. **Your AgentRouter key** — the credential, stored only on your machine
3. **The shared config** (`omp-setup/`) — provider definitions, extensions, settings

Read once, then follow Steps 1 → 7.

---

## Step 0 — Prerequisites

- macOS or Linux (Windows works for upstream omp, see Step 1A)
- `git`, `curl` — present on macOS by default
- **Bun ≥ 1.3.14** (needed for the fork build):

```sh
curl -fsSL https://bun.sh/install | bash
```

- A Rust toolchain only if `bun setup` complains about natives (macOS: `xcode-select --install`)

---

## Step 1 — Install omp

### Option A: official binary (fastest, 1 minute)

```sh
curl -fsSL https://omp.sh/install | sh
```

Alternatives:

```sh
brew install can1357/tap/omp
# or
bun install -g @oh-my-pi/pi-coding-agent
```

Check: `omp --version`

### Option B: this fork (recommended)

The fork adds `omp models probe` (checks which models actually respond), a session-only
model picker (`Ctrl+N` / `Cmd+O`), composer file-attachment chips, 210+ bundled skills in `.omp/skills`,
and native gateway providers (`agentrouter`, `justdowork`, `tabitoken`, `gorouter`, `kktoken`, `tokenforge`).

```sh
git clone https://github.com/Nariiius/oh-my-pi.git
cd oh-my-pi
bun setup        # installs deps, builds the native addon (a few minutes)
bun dev -- --version
```

- `bun dev` runs the CLI **from this clone**. Both `main` and `local-custom-v18` include all custom features.
- You can have the official binary *and* this clone side by side — they're unrelated.

---

## Step 2 — Get the shared setup

Unzip `omp-setup.zip` (or use the `omp-setup/` folder). It contains:

```
omp-setup/
├── install.sh                      # one-command installer
├── GUIDE.md                        # this file
├── README.md                       # quick overview
└── agent/
    ├── extensions/agentrouter.ts   # AgentRouter WAF handshake (the important part)
    ├── extensions/guard.ts         # safety: redacts secrets, gates dangerous commands
    ├── models.yml                  # defines the agentrouter provider
    ├── config.yml                  # omp settings (model roles, approval mode, …)
    ├── mcp.json                    # Context7 MCP (placeholder key — optional)
    ├── .env.example                # template for your credentials file
    ├── rules/, themes/, scripts/   # extras
```

---

## Step 3 — Install everything

```sh
cd omp-setup
bash install.sh
```

What it does:

| Item | Goes to | Notes |
| --- | --- | --- |
| extensions | `~/.omp/agent/extensions/` | auto-loaded on next start |
| `models.yml` | `~/.omp/agent/models.yml` | defines `agentrouter` provider |
| `config.yml` | `~/.omp/agent/config.yml` | existing file is backed up as `*.bak-<ts>` |
| `mcp.json` | `~/.omp/agent/mcp.json` | **only if you have none** — never clobbers |
| rules / theme / scripts | `~/.omp/agent/{rules,themes,scripts}/` | |
| `.env` | prompted | see next step |

If you skipped the key prompt (or ran it non-interactively), do Step 5 manually.

---

## Step 4 — Get your AgentRouter API key

1. Go to **https://agentrouter.org** → sign up
2. Dashboard → API keys → create a key
3. Copy it. This is the *only* secret in the whole setup — never share it, never commit it

AgentRouter is a prepaid gateway: calls draw from a **budget pool**. When the pool is
empty you get HTTP 402 (see Troubleshooting). Models defined: `glm-5.3`, `gpt-5.6-sol`,
`deepseek-v4-flash`, `gpt-5.5`, `glm-5.2` (OpenAI-compatible) plus `claude-opus-5`,
`claude-opus-4-8`, `claude-opus-4-6` (Anthropic-compatible). Official docs:
https://agentrouter.org/docs/pi.html

---

## Step 5 — Put the key in place

If `install.sh` prompted you and you pasted the key, skip to Step 6.

Otherwise, create `~/.omp/agent/.env` (one line, no spaces, no quotes):

```sh
open -e ~/.omp/agent/.env     # or: nano ~/.omp/agent/.env
```

The file is a single line: the variable name `AGENTROUTER_API_KEY` followed by `=` and
your key. Then lock it down:

```sh
chmod 600 ~/.omp/agent/.env
```

Alternative: export the same variable (`AGENTROUTER_API_KEY`) in your shell profile
instead of a file — omp reads either.

Restart omp before continuing.

---

## Step 6 — Verify with the model probe

```sh
omp models probe agentrouter
```

(If you built the fork, `bun dev -- models probe agentrouter` from the clone.)

Real output from a working setup:

```
[1/5] agentrouter/glm-5.3
[2/5] agentrouter/gpt-5.6-sol
[3/5] agentrouter/deepseek-v4-flash
[4/5] agentrouter/gpt-5.5
[5/5] agentrouter/glm-5.2
  OK   agentrouter/glm-5.3 (1.8s)
  FAIL agentrouter/gpt-5.6-sol (0.6s) — HTTP 402: 402 Budget pool quota has been exhausted…
  OK   agentrouter/deepseek-v4-flash (1.5s)
  FAIL agentrouter/gpt-5.5 (20.0s) — Request was aborted
  FAIL agentrouter/glm-5.2 (20.0s) — Request was aborted

2/5 models responded. Run with --apply to write the working models to enabledModels.
```

Reading it:

| Output | Meaning |
| --- | --- |
| `OK` (fast) | works — your key, WAF handshake, routing all good |
| `HTTP 402 … Budget pool quota` | key works, but the pool is empty — top up at agentrouter.org |
| `Request was aborted` (20s) | model too slow for the default timeout — retry or raise it |

Write the working models into your config so the picker shows only what responds:

```sh
omp models probe agentrouter --apply
```

Useful flags: `--json` (machine-readable), `--timeout 60` (seconds per model).
Inside a session: `/model probe agentrouter` opens the live probe view.

---

## Step 7 — Use it

1. Start omp: `omp` (or `bun dev` from the fork clone)
2. Open the model picker (`Alt+P`, or `Ctrl+N`/`Cmd+O` on the fork) and pick
   `agentrouter/deepseek-v4-flash`
3. Ask it something. The footer shows the active model and running cost
4. Your default role is already agentrouter in `config.yml` (`modelRoles.default`)

---

## Step 8 — Optional: MCP servers (Context7)

`mcp.json` ships with a **placeholder** Context7 key, so the server won't work until you:

- Get a free key at **https://mcp.context7.com** and paste it into
  `~/.omp/agent/mcp.json` (`CONTEXT7_API_KEY` field), **or**
- Delete the whole `context7` block from that file if you don't want it

A placeholder key never breaks omp — it only fails that one MCP tool.

---

## Step 9 — Optional: tune which models you see

`~/.omp/agent/config.yml`:

- `enabledModels:` — models offered in the picker. Trim it to providers you actually
  have keys/logins for (Cursor and GitHub-Copilot models need their own logins).
- `modelRoles:` — the roles omp cycles through:

```yaml
modelRoles:
  default: agentrouter/deepseek-v4-flash:high
  smol:    opencode-go/hy3
  slow:    opencode-go/kimi-k3:high
  vision:  cursor/cursor-grok-4.6:auto
  plan:    agentrouter/glm-5.3:high
```

Format: `provider/model:effort` — `:auto`/`:high`/`:low` etc. Set roles to models you
verified with the probe.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401 unauthorized_client` from agentrouter | AgentRouter WAF: first system prompt must be the canonical Pi header | Ensure `~/.omp/agent/extensions/agentrouter.ts` exists and restart omp. The extension rewrites the header **only on agentrouter routes** |
| `HTTP 402 Budget pool quota` | Prepaid pool empty on your key | Top up / pick a different pool at agentrouter.org |
| `Request was aborted` | Default 20s probe timeout too short for slow models | `omp models probe agentrouter --timeout 60` |
| Model missing from picker | Not in `enabledModels` | `omp models probe agentrouter --apply` or edit `config.yml` |
| Everything 401s | Extension not loaded | Confirm file path + restart; check `~/.omp/agent/extensions/` contents |
| Context7 errors in session | Placeholder key | Add real key or delete the `context7` server block |
| Guard asks before commands | That's `guard.ts` (by design — it gates sudo, push --force, network egress…) | `tools.approvalMode: yolo` is already set; to remove the layer entirely, delete `~/.omp/agent/extensions/guard.ts` and restart |
| Fork behaves like upstream | Wrong branch or wrong install | Run via `bun dev` from this clone |
| `.env` not picked up | Wrong path or stale session | Path must be exactly `~/.omp/agent/.env`; restart omp; or `export` the variable |

---

## Security checklist

- [ ] `.env` exists only on your machine, mode `600`, never shared
- [ ] `mcp.json` uses your own Context7 key (or no server at all)
- [ ] If you ever commit `config.yml` / `models.yml`, they contain **variable names,
      not keys** — that's by design
- [ ] `guard.ts` redacts secrets (GitHub/npm/Slack tokens, key assignments) before they
      reach the model — keep it unless it annoys you

---

## Files at a glance

| Path | Purpose |
| --- | --- |
| `~/.omp/agent/.env` | your credentials (never shared) |
| `~/.omp/agent/models.yml` | provider definitions, incl. `agentrouter` |
| `~/.omp/agent/config.yml` | settings, model roles, enabled models |
| `~/.omp/agent/extensions/agentrouter.ts` | WAF handshake — makes agentrouter accept requests |
| `~/.omp/agent/extensions/guard.ts` | secret redaction + dangerous-command gates |
| `~/.omp/agent/mcp.json` | MCP servers (Context7, optional) |
| `~/.omp/agent/rules/no-dangerous-rm.mdc` | rule: refuse destructive `rm` |
| `~/.omp/agent/themes/pi-dark.json` | the dark theme |
| `~/.omp/agent/scripts/probe-*.sh` | bulk model-probe helpers |
| `.omp/skills/` | 212+ pre-installed capability skills |
