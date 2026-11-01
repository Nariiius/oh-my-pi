# Local changes and upstream merge guide

This is the conflict-resolution map for this fork, not an upstream release changelog. Read it before merging or rebasing upstream. Preserve the local behavior below while incorporating upstream fixes; do not choose entire files with `ours` or `theirs`.

## Scope and baseline

- Last integrated upstream: **v18.12.6 plus Unreleased fixes**, commit `0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0` (source tip dated 2026-10-22).
- Fork branch: `local-custom-v18`; pre-integration HEAD: `09863a8153`; backup: `backup/local-custom-v18-before-upstream-20261026`. Original feature-split HEAD: `0e0c8f9ca8`.
- Scope: the **entire net fork delta from the integrated upstream baseline**, including model probes, gateway policy, skills, file chips and account/footer behavior. Existing custom commits are not rewritten.
- Historical v18.8.3 inventory before the feature split touched 882 files: 774 added skill assets and 108 other files. The refreshed post-integration inventory is below; do not infer feature boundaries from broad earlier commit subjects.
- `README.md` describes the fork; `GUIDE.md` describes setup. This document is the preservation checklist. Older setup claims can exceed actual wiring; the limitations below take precedence.

To reconstruct the exact current file inventory and inspect a conflicting feature:

```sh
base=0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0
git diff --name-status "$base" HEAD
git diff "$base" HEAD -- packages/coding-agent/src/cli/models-cli.ts
git log --oneline "$base"..HEAD -- packages/coding-agent/src/cli/models-cli.ts
```

After each upstream integration, record the actual integrated upstream commit here, refresh this inventory against it, and add/remove preservation rules as behavior converges with upstream. Do not replace the baseline with the latest remote tip unless it was actually integrated.

## Durable cross-chat outbox

- `packages/coding-agent/src/outbox/` owns private SQLite state, attachments, quota admission, ordered claiming, live delivery, crash reconciliation and the supervised worker. CLI/slash commands, `OutboxSelectorComponent`, the input controller and native composer expose the shared controls.
- Preserve the prompt admission lock and atomic `outbox.delivery` acceptance/user-message and completion receipts in `AgentSession`/`SessionManager`. A queued destination must never take the normal silent sibling-fork path when owned elsewhere.
- SDK startup protects queued destinations before workspace/model writes; live root sessions participate in the profile inbox. Closed execution acquires the exact lease and uses the normal SDK, without enabling interactive approvals or widening permissions.
- `ModelUsageAccountHealth.clearedAt` is the latest applicable exhausted reset, unlike `resetsAt` (earliest recheck). Unknown telemetry stays blocked. Preserve temporary no-fallback and authoritative-reset-wait overrides.
- The coordinator reuses `launch/` persistent supervision and holds an idle-sleep assertion while armed work remains. It is not a boot service. Accepted-but-unfinished crashes require review, never unconditional `Continue` or prompt replay.
- Preserve the Current/All view state, Add destination binding, live `session_snapshots` updates, stale status handling and safe editor roundtrip. Activity publishing is independent of the blocked delivery loop; native/terminal renderers must share the same status semantics.
- Resume watches are `kind=resume`, anchored to `resumeUserEntryId`, and stay in `watching` while pending; a SQL trigger normalizes old `queued`/`waiting` updates so old workers cannot accidentally send the display label as a prompt. Preserve additive migration and atomic deduplication.
- `outbox/resume.ts` drives independent quota waits and retries through the normal continuation pipeline with native auto-retry disabled per attempt. Preserve exclusive admission, cancellation, known-native-sleep takeover, same-request/no-new-prompt behavior, safe attempt receipts, and preserved held follow-up queues.
- Scheduling separates globally ordered messages from independent per-chat resume watches. Preserve `outboxJobBlocker`/atomic claim parity, same-chat barriers, recovery of every dead owner, distinct SDK agent IDs for concurrent closed chats, executor draining, and worker protocol 3. UI blockers must use the same rules; a live old process must reopen to load them.
- Worker adoption must distinguish the broker's `readyMatch` (the launching client's pattern) from the worker's advertised protocol. A protocol-3 worker launched by a protocol-2 client is compatible; verify its output and generation instead of restarting it. Wait for in-progress launches and concurrent replacement winners. Reopen all participating old chat processes to load client-side fixes; restarting only the worker cannot replace their in-memory code.
- Outbox removal is an explicit permanent store operation shared by native/terminal controls and slash/CLI commands. Check active state under an immediate transaction, validate attachment ownership before deleting, and commit row removal before image cleanup so another process cannot claim a half-deleted job. Keep session history and delivery receipts untouched.
- Verification: outbox store/readiness/delivery/coordinator/UI/selector/activity/destination/resume tests, independent multi-process status/resume scenarios with native retry disabled, existing retry/storage/editor/health regressions, and actual terminal/native Tern surfaces.

## Merge procedure

1. Record the starting branch/HEAD and preserve any unrelated uncommitted work. Determine which remote is upstream; do not assume this fork's `origin` is upstream.
2. Read the relevant feature sections and the baseline-to-fork diff, including callsites, tests, authored config, package exports and generated artifacts.
3. Resolve behavior, not line ownership. Keep newer upstream transport, auth, validation and persistence safeguards. Carry local changes through renamed/moved APIs instead of restoring obsolete interfaces.
4. Resolve authored KDL and documentation first; regenerate derived catalog rules/docs using the repository's generators. Keep required runtime snapshots and skill resources.
5. Run the affected per-file tests and a source CLI/component smoke. Follow `AGENTS.md`: no bare full `bun test`; stage explicit paths. Do not make network probes or write model settings without understanding the effects below.
6. Commit one feature at a time, including its broken callers/tests/docs. Keep formatting-only changes separate. Update this guide in the same integration when a hotspot moves or a limitation changes.

## Feature map

Paths in this section are relative to the repository root. Shared files deliberately occur in more than one feature: a conflict in `agent-session.ts`, `interactive-mode.ts`, `models-cli.ts`, the status line or catalog model policy can affect several behaviors.

### 1. Model probing, persistence and health badges

**Behavior:** `omp models probe [pattern] --apply --timeout N --json`, `/model probe` and `/models probe` send a minimal request through omp's own provider/auth routing. Exact provider matching takes precedence over case-insensitive provider/id/name substring filtering. Only authenticated eligible chat models are probed. Defaults: 20 seconds/model and concurrency 8; final results retain input order. A successful non-error/non-aborted response is enough; content is not required to equal `OK`.

**Hotspots:**

- `packages/coding-agent/src/cli/{models-cli,command-help}.ts`, `src/commands/models.ts`, `src/slash-commands/builtin-modes.ts`.
- `src/main.ts`, `src/config/model-registry.ts`, `src/session/{agent-storage,agent-session}.ts`.
- `src/modes/controllers/selector-controller.ts`, `src/modes/components/models-probe-panel.ts`, `src/modes/{interactive-mode,types}.ts`.
- `src/slash-commands/helpers/stats-dashboard.ts` and `packages/tui/src/overlays/{model-browser,model-picker}.ts`.

**Preserve:** actual wire model identity, API-specific auth, provider extension hooks, headers, compatibility policy and OAuth payload handling. Do not replace this with unrelated raw HTTP requests. Retain SQLite `model_probe` storage, second-to-millisecond legacy timestamp normalization, registry cache and selector health glyphs/ages together.

Applying a partial probe expands existing wildcard selectors, removes failed selectors inside the probe scope, preserves unprobed selectors and adds successful models. Failed pinned roles are pruned only after a nonempty merged set. An empty merged set currently writes `enabledModels=[]`, flushes settings and returns `applied:false`; that return is not a no-mutation guarantee. Zero successes can still yield `applied:true` if unprobed enabled selectors survive.

**Side effects:** probes run only on explicit CLI/slash commands, never automatically on startup. Each matching model sends a potentially billable request; use a provider/model filter to limit the run. Successful empty responses must not trigger replay requests. Health results are recorded without applying enabled-model settings; explicit `--apply`/panel apply mutates configuration. The panel's legacy `autoApply` option is not a promise of automatic apply on completion.

**Checks:** `test/models-probe-cli.test.ts`, `test/models-probe-all-apis.test.ts`, `test/models-probe-panel.test.ts`, `test/slash-commands/models-probe-dispatch.test.ts` under coding-agent. The API integration file covers concrete API families, not every possible catalog API/provider.

### 2. Native model-probe picker and stable incremental updates

**Behavior:** the interactive probe view uses the native picker when supported, otherwise its terminal/card fallback. Native rows expose latency/status, live order, selection, enabled models and explicit apply/toggle/show-failed/close actions. Failed models remain unselectable; closing/disposal prevents later callbacks from changing the UI.

**Hotspots:** `packages/coding-agent/src/modes/components/models-probe-panel.ts`, `src/modes/interactive-mode.ts`, `test/models-probe-panel.test.ts`; existing native picker/reconciler contracts in tui and wire.

**Preserve:** 350ms coalescing, stable published snapshots across unrelated redraws, incremental item updates without losing unpublished results, failed-row removal transitions and selection tied to model identity rather than a disappearing row index. Keep unchanged rows out of retransmission. Native sheet routing must recognize this picker as well as existing model pickers. Keep keyboard navigation, mouse/scroll handling, terminal fallback and explicit Enter-apply/Escape-close behavior.

### 3. Per-request probe account attribution

**Behavior:** probe panel, text output and JSON identify the compact account actually resolved for that request. Identity is optional when credentials do not expose it.

**Hotspots:** `packages/coding-agent/src/cli/models-cli.ts`, `src/modes/components/models-probe-panel.ts`, `test/{models-probe-all-apis,models-probe-panel}.test.ts`, `packages/utils/src/format.ts`.

**Preserve:** derive identity from the resolved `credentialId`, not the globally/session-active account. Concurrent probes and credential rotation can use a different account from the footer. Preserve native account facts/badges, terminal/fallback labels and text/JSON output; clean control characters before native row publication. Account-only changes must survive batching and trigger the relevant item update.

`formatCompactAccountEmail` is shared through utils' existing `export *` from `format`: long non-email IDs use first four/last two characters; emails compact long local parts to first three/last three and domains to two characters. Do not silently introduce a second formatter or change the display contract while resolving imports.

### 4. OAuth account selection before model-switch redraw

**Behavior:** both `AgentSession.setModel` and `setModelTemporary` select/resolve the OAuth account before mutating the current model and emitting the change. No model request is sent. API-key resolution remains deferred until a request.

**Hotspots:** `packages/coding-agent/src/session/agent-session.ts`, `test/agent-session-model-switch-auth.test.ts`; auth-storage/model-registry APIs used by these methods.

**Preserve:** same-provider models can have different account access. Resolve eligible OAuth identity before the footer sees `model_changed`; a failed selection leaves the current model unchanged. Keep temporary selection's no-persistence contract. Do not reintroduce eager command-backed API-key execution or network API-key validation during every picker switch.

### 5. Temporary picker, cycle-selection slot and thinking order

**Behavior:** persistent hub remains `Alt+M`; temporary picker is `Ctrl+N`, with `Super+O` bound on macOS. Role cycling has a virtual `selection` entry that opens the temporary picker. Shift+Tab cycles canonical supported thinking levels, deduplicated and excluding `auto` from manual cycling.

**Hotspots:** coding-agent `src/config/{model-roles,model-resolver}.ts`, `src/session/{agent-session,agent-session-types,model-controls}.ts`, `src/modes/controllers/{input-controller,selector-controller}.ts`; tui `src/app-keybindings.ts`, `src/native-modifiers.ts`, `src/index.ts`.

**Preserve:** selection is a UI sentinel, not a real model/known durable role. Cycle callers must tolerate an absent model with `openPicker:true`. Session-only selection must not overwrite the saved default. Keep `ctrl+shift+p` backward cycling and feedback when thinking changes.

**Limitation:** the CoreGraphics native modifier helper is exported but has no retained consumer. Do not claim a non-Kitty Cmd+O fallback works just because the helper exists.

**Checks:** coding-agent `test/{agent-session-model-persistence,agent-session-model-switch-auth,agent-session-role-thinking,model-resolver}.test.ts`.

### 6. Pi two-line footer and native provider/account facts

**Behavior:** Pi composer shape enables an early-return two-line status footer: path/identity/session on one line, cost/context/provider-model/thinking on the next. Native composer facts also include provider-qualified model and compact account identity.

**Hotspots:** tui `src/status-line/{component,types}.ts`, `src/prompt/composer.ts`, `src/theme/{symbols,theme-class}.ts`; coding-agent `src/modes/{interactive-mode,status-line-host}.ts`, `test/status-line-settings-cache.test.ts`; utils `src/format.ts`.

**Preserve:** ANSI-visible-width clipping, home/project-relative path rules, context thresholds/autocompact markers, user icon across glyph modes, shape/preference synchronization and existing settings invalidation. Pi's early return bypasses normal plugin/status rows; it is not merely another preset.

Native memo inputs must track provider and account changes, including rotation and disappearance, even if the displayed model name is unchanged. Do not show a stale account because the native facts fingerprint otherwise matches. Account display is provider-specific and uses identity rather than token contents.

**Privacy:** compact identities are still identifiers visible in screenshots/transcripts; they are not anonymization.

### 7. Atomic pasted-file chips and real ingestion

**Behavior:** non-image pasted file paths become atomic composer chips, rendered as filename/path cards in terminal and native input. Expansion retains the real `@path` mention for existing submit-time file ingestion. Images keep the existing image path; invalid, blank and unrepresentable paths remain ordinary text.

**Hotspots:** coding-agent `src/modes/controllers/input-controller.ts`, `test/input-controller-file-paste.test.ts`; tui `src/prompt/{custom-editor,composer-attachments,attachment-chips}.ts`, `src/status-line/types.ts`, `src/overlays/model-browser.ts`, `test/{custom-editor,attachment-chips}.test.ts`; `docs/keybindings.md`.

**Preserve:** quoting/whitespace handling, filename/path metadata, atomic navigation/deletion, removal, undo and cleared-draft recall. Never substitute a display-only chip that loses file content on submit. `CustomEditor.onPasteFilePath` remains the shared callback wired to `InputController.handleFilePaste`; both ordinary and guarded draft input must route through the same bracketed-paste handling. File chips and images must coexist without exhausting image-only attachment budget.

### 8. Gateway providers, WAF headers, schemas and extension hooks

**Behavior:** runtime registration adds `agentrouter`, `gorouter`, `kktoken`, `justwoker`, `justdowork`, `tokenforge`, `tabitoken`. OpenAI-compatible discovery factories have curated fallbacks and endpoints. Known gateway routes receive `User-Agent: pi-code` and proxy-compatible schemas. AgentRouter/recognized router payload hooks enforce the Pi root header and convert developer messages to system where required.

**Hotspots:**

- ai `src/registry/{agentrouter,gorouter,justdowork,kktoken,tabitoken,tokenforge,registry}.ts`.
- ai `src/providers/{anthropic,openai-shared,openai-completions,openai-responses,openai-codex-responses}.ts`, `src/utils/schema/normalize.ts`.
- catalog `src/provider-models/{openai-compat,descriptors}.ts`, `src/compat/resolve.ts`.
- coding-agent `src/extensibility/extensions/{agentrouter,loader}.ts`, `examples/extensions/agentrouter.ts`, `src/config/models-config-schema-bundle.ts`.

**Preserve:** both JustWork identifiers and registry side-effect imports. Endpoints include `agentrouter.org/v1`, `gorouter.app/v1`, `kktoken.com/v1`, `justwoker.ai/v1`, `tokenforge.ai.studio/v1`, `tabitoken.com/v1`. Keep fallback seeds, reasoning/max-token compatibility and retired-Haiku filtering.

Tool normalization accepts full `Model<Api>` as well as provider strings. Retain every full-model caller so URL-based detection works for custom provider IDs. Strict proxy normalization is recursive through properties/items/unions: removes unsupported keywords, normalizes nullable-string types and integer types, omits optional-only `required`; official-provider schemas and Gemini rules retain their own behavior. Keep AgentRouter DeepSeek reasoning forced-tool-choice disabled by provider or URL.

Gateway header detection currently includes substring URL matching, not parsed-host matching. Built-in router hooks load before discovered user extensions and are restricted to recognized routes; the narrower example can duplicate hooks if loaded too. Preserve discovery-tool API environment construction from merged discovered tools rather than reverting to a fixed built-in list.

**Limitations:** custom discovery factories are not sufficient by themselves: the compiled provider-entry registry has no corresponding new custom KDL entries. Do not promise universal automatic model discovery. The legacy `CATALOG_PROVIDERS` export remains retained compatibility. Arbitrary extra OpenAI compat keys remain allowed.

**Checks:** ai `test/{auth-hooks-registry,gateway-waf-headers,openai-completions-compat,schema-helpers}.test.ts`; catalog `test/build.test.ts`; coding-agent `test/issue-5764-registertool-loadmode.test.ts`.

### 9. Antigravity catalog/routing and deterministic effort sorting

**Behavior:** explicit configured provider/model routes take priority over catalog alias rewrites. Antigravity aliases, newer Claude thinking families/pricing peers and curated fallback models are retained alongside newer upstream families. Retired Claude 3.5 Haiku models are filtered. Model IDs and supported efforts sort in canonical thinking-effort order.

**Hotspots:** catalog `src/compat/{collapse,resolve}.ts`, `src/compat/rules.json`, `src/compat/rules/{taxonomy/_collapse,runtime/behavior}.kdl`, `src/provider-models/google.ts`, `scripts/generate-models.ts`, `src/identity/id.ts`, `src/discovery/cursor.ts`, `src/model-thinking.ts`, `src/wire/gemini-headers.ts`; coding-agent `src/config/model-resolver.ts`, `test/model-resolver.test.ts`.

**Preserve:** canonicalization before reviewed-collapse/provider-variant lookup, aliases `gemini-antigravity`/`antigravity`, Claude Opus/Sonnet 5/5.5 and Opus 4.7/4.8 families, existing newer upstream Gemini/Claude variants, dynamic-over-curated fallback precedence and explicit native route identity. Do not retire `gemini-3.1-pro-high` by restoring the old collapse table. The unused curated-fallback import in the generator does not itself add bundled rows.

Shared `compareModelIdsWithThinkingEffort` orders same-base variants as base/minimal/low/medium/high/xhigh/max with qualifier/lexical tie-breaks; supported-effort retrieval returns a sorted copy. Keep this order in consumers, not lexicographic effort spelling.

Resolve authored KDL first, then run `bun --cwd=packages/catalog run gen:compat`; never pick an arbitrary side of generated `rules.json`. Model generation is `gen:models` and can have its own external data dependencies. Use current upstream wire-version handling (Gemini CLI default 0.46.0; Antigravity manifest discovery with 2.19.1 offline fallback), not the former local 1.19.6/google-cloud-sdk literals. Extra local Claude wire profiles remain additive.

### 10. OpenRouter fallback pricing and proxy-cache estimates

**Behavior:** zero-priced models can use a retained 409-model OpenRouter snapshot, with asynchronous unauthenticated refresh and previous-cache retention on failure. Supported-family zero-cache reports may infer cache reads from the preceding prompt; session usage and stats recalculate cost accordingly.

**Hotspots:** catalog `src/{openrouter-pricing,models,index}.ts`, `src/openrouter-pricing-snapshot.json`, `package.json`; coding-agent `src/session/agent-session.ts`; stats `src/{parser,db}.ts`.

**Preserve:** existing nonzero provider prices win. Pricing snapshot is a runtime dependency, not a throwaway fixture; maintain root and `./openrouter-pricing` exports. Keep suffix/family matching, per-token to per-million conversion, bounded refresh and cache retention on failures.

Reported cache wins over estimates. Keep the previous-prompt/current-prompt minimums, current 1024-token reserve, 128-token alignment and family discounts. Mutating input/cacheRead must not inflate the original `totalTokens`. Estimates can apply by supported family beyond custom gateways; they are not verified provider billing.

Parser state persists/restores the previous assistant prompt size; stats backfill walks session rows in order and updates costs transactionally. **Known anomaly:** the backfill completion marker is written for the empty-candidate case, not after a nonempty successful pass, so later opens can recheck. Do not describe it as proven one-shot migration.

Synchronous pricing lookup can trigger background network activity. The snapshot/cache tests do not prove remote API freshness or availability.

**Checks:** catalog `test/openrouter-pricing.test.ts`; inspect live session and stats consumers if upstream changes usage shape. No new dedicated stats parser/backfill regression coverage was found in the retained delta.

### 11. Quota classification, usage reports and unwired usage UI

**Behavior:** hard/free-tier/quota/billing exhaustion is distinguished from retryable per-minute rate limits in ai `src/error/rate-limit.ts`. Session usage reports include configured API-key providers/model IDs, token counts and USD session cost as well as existing OAuth reports.

**Hotspots:** ai `src/error/rate-limit.ts`, `src/usage/openrouter.ts`; coding-agent `src/session/agent-session.ts`, `src/modes/components/usage-panel.ts`, `test/usage-panel.test.ts`, `src/modes/controllers/command-controller.ts`.

**Preserve:** session usage is not provider quota/billing truth. Undefined quota fraction/reset must remain undefined; do not synthesize fake limits. Keep report ordering and authenticated providers even without OAuth limit data. Keep OpenRouter fetch signal/error handling and null-on-invalid-response behavior if its provider is integrated later.

**Limitations:** `openrouterUsageProvider` is not registered in `DEFAULT_USAGE_PROVIDERS`. The new fullscreen `UsagePanelComponent` is defined/tested but not mounted by the retained `/usage` command, which still uses the existing report UI. Do not advertise either artifact as connected functionality. Neither is completed by the feature commits in this guide.

**Checks:** ai `test/rate-limit-utils.test.ts` and coding-agent `test/usage-panel.test.ts`; component coverage does not prove slash-command mounting.

### 12. Skill packs, filesystem discovery and direct slash commands

**Behavior:** `.omp/skills/` adds 774 files across 213 new top-level directories (358 directories including nested resources). Skills include marketing, engineering, Google Workspace, design, documents and tooling. Preserve their references, scripts, schemas, font/license files, PDF and archive resources—not just `SKILL.md`.

**Hotspots:** `.omp/skills/**`; coding-agent `src/extensibility/skills.ts`, `src/slash-commands/{builtin-marketplace,available-commands}.ts`, `src/modes/skill-command.ts`, `src/modes/{interactive-mode,acp/acp-agent,rpc/rpc-mode}.ts`, `src/tools/xdev.ts`, `src/cli/help-extra.ts`; `test/{skills,rpc-skill-command}.test.ts`.

**Preserve:** built-in archive skills are opt-in via `enableBuiltinSkills`. `OMP_SKILL_PACK_PATHS` accepts platform-delimited paths with comma fallback, resolves relative to cwd and deduplicates existing recursively loaded directories. Keep explicit custom/additional directory settings; those are not removed. Marketplace installation uses the normal filesystem tree, enables skill commands and disables built-in merging; reload rescans/reset-capabilities rather than re-unpacking the archive.

Direct `/<registered-skill>` invocation must agree across interactive, ACP, RPC and available-command metadata. Respect `enableSkillCommands`, built-in reserved names/aliases and first-name deduplication; colon-containing direct names are rejected. Existing `/skill:name` and `skill://` forms remain. Top-level xdev help/list/get/inspect_image exposure is retained.

A checkout's skill tree and external skill packs are different sources. Packaged distributions must actually carry/discover assets; loader code alone does not guarantee that. Skill counts are inventory counts, not evidence every skill script runs. See the exact diff inventory command for all asset paths.

### 13. Binary/protobuf, SQLite and native compatibility

**Hotspots and contracts:**

- catalog `src/discovery/protobuf.ts`, `test/protobuf.test.ts`: accept ArrayBuffer views/DataView without copying, preserving byte offsets/lengths; also validate ArrayBuffer, Buffer JSON and contiguous numeric byte-key representations where applicable. Views are bytes, not message objects. Keep malformed-byte rejection and actual wire decoding; not every byte-like JSON object is valid top-level callable decode input.
- utils `src/sqlite.ts`: retained `checkpointWal` uses `PRAGMA wal_checkpoint(PASSIVE)` and tolerates closed/incompatible databases. Coding-agent judgment/session/history storage callers still depend on it. Do not replace passive checkpointing with destructive truncation.
- natives `native/vcs.js`: missing native VCS methods return null/false rather than throwing. These guards can suppress discovery on mismatched binaries; align wrapper and native capabilities after upstream changes.
- coding-agent `test/guard-extension.test.ts`: preserves Uint8Array/Buffer/ArrayBuffer through extension handling. The added test does not establish a new implementation change in the otherwise unchanged guard extension.

**Checks:** catalog `test/protobuf.test.ts`, coding-agent `test/guard-extension.test.ts`, utils `test/sqlite.test.ts` (existing SQLite coverage, not a dedicated checkpoint test). Native compatibility needs an actual compatible addon, not source inspection alone.

### 14. Reconciled safeguards and retained drift

These are part of the net delta, **not automatically intentional requirements**. Do not silently perpetuate them or silently drop them; explain the resolution.

- ai `src/providers/cursor.ts` now retains current upstream caller-header forwarding/sanitization for HTTP/2 Run; `test/cursor-caller-headers.test.ts` is restored. Keep its real-wire protection of auth/content-type/request-ID/pseudo/connection headers; the earlier local deletion is not a requirement.
- catalog `src/wire/gemini-headers.ts` and ai Gemini request assembly follow the current upstream wire/version design. The former local merge-helper/version differences are superseded; keep the additive Antigravity model profiles without reviving obsolete helpers or pinned client versions.
- Removed the unused local `src/internal-urls/docs-index.generated.ts` blob. Current source loads repo docs; bundle/compiled builds use `buildDocsIndexPayload()` and the shipped `dist/docs-index.generated.txt`/build-time embed. Do not restore the stale TypeScript snapshot.
- coding-agent `CHANGELOG.md` includes inserted old 17.x history before later 18.x sections. Treat as historical drift, not new feature evidence.
- coding-agent `src/modes/interactive-mode.ts` retains optional session/settings/title/goal guards, an unused import and whitespace drift. Keep actual error/validation behavior when moving code; do not infer a supported API from fixture-shaped optional guards.
- coding-agent `src/modes/controllers/event-controller.ts` suppresses repeated identical errors until reset and includes the original error in retry countdowns. It is stateful and lacks dedicated retained regression coverage.
- `test/startup-composer.test.ts` accepts more leading border glyphs; `test/issue-5764-registertool-loadmode.test.ts` changes expected discovered tool count alongside loader changes. Those assertions are not substitutes for verifying the user-facing behavior.
- The final `packages/catalog/src/models.ts` line wrap and `packages/coding-agent/test/skills.test.ts` formatting changes are formatting-only and committed separately.

## Original feature commit boundaries

Find the exact original hashes with `git log --oneline 0e0c8f9ca8..09863a8153`. Each behavior commit includes its own changelog/tests; shared panel/changelog files were split through the index rather than rewriting earlier history.

1. Atomic pasted-file chips and submit-time file ingestion.
2. Shared compact account formatter and native footer/provider-account invalidation.
3. Native probe picker, stable batching and native sheet routing.
4. Per-request probe account attribution across native/terminal/text/JSON surfaces.
5. OAuth account selection before model-switch redraw.
6. Formatting-only collateral.
7. This full-fork guide and README/AGENTS discovery links.

## Historical verification record: v18.8.3 feature split

- Final feature checks passed: attachment-chips (14), custom-editor (90), input-controller-file-paste (17), models-probe-all-apis (8), models-probe-panel (27), agent-session-model-switch-auth (6), status-line-settings-cache (14), skills (61), and probe CLI (15): 252 tests, zero failures.
- The isolated native-picker index snapshot, without the later account feature, also passed its 26 panel tests and a local HTTP/native-picker/terminal/apply runtime smoke. The temporary checkout needed the existing generated HTML tool-view asset linked before it could run.
- Source CLI `--version` reported `omp/18.8.3`; `models --help` exposed probe flags/examples.
- A throwaway local runtime smoke exercised actual editor/file ingestion and atomic removal; terminal attachment rendering; session OAuth account selection before redraw; native footer facts; real local HTTP/SSE probes with rotated credential attribution; native picker/terminal rendering and Enter apply. The probe account differed from the footer account, verifying request attribution rather than a global identity echo.
- No live provider credentials/remote probes, full suite, native desktop renderer/hardware interaction, skill script sweep or historical stats migration were verified. Component/native wire output is not proof of desktop animation behavior. Temporary smoke files were moved outside the repository.

Future merges must rerun the relevant checks on the new tree; this record is not an evergreen pass claim.

## Upstream integration: 2026-10-26

- Integrated `origin/main` at `0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0` (source tip dated 2026-10-22). Version moved from 18.8.3 to 18.12.6; this tip also contains the upstream Unreleased fixes. The previous upstream base was `3e3c488a58d294e3a10051da588628e2cfb9d35c`: 5,071 incoming commits and 2,729 changed paths.
- Preserved the pre-integration fork at `backup/local-custom-v18-before-upstream-20261026` (`09863a8153`). The custom branch and fork remote/tracking remain in place; no push or history rewrite was performed.
- Resolved 14 conflicts by retaining both upstream lifecycle/transport APIs and local behavior. Cline compatibility now comes from upstream KDL rather than the removed `isClinePass` field. Regenerated `compat/rules.json` from the merged authored KDL (1,096 rules).
- The upstream editor centralizes bracketed paste for normal and guarded draft input; file-path chip preparation now runs through that shared path. Kept upstream background-call/approval lifecycle state alongside local repeated-error suppression and probe routing.
- Retained upstream Cursor header sanitization and restored its HTTP/2 wire regression file. Adopted current upstream Gemini/Antigravity header/version handling while keeping extra local model wire profiles. Removed the unused old generated TypeScript docs blob; current source/bundle docs mechanisms are authoritative.
- Corrected two earlier guide inaccuracies without changing the pre-merge behavior: `onPasteFilePath` is an active shared callback, and the background startup probe records health but does not apply enabled-model settings. Explicit probe apply still persists settings as described above.
- Installed locked dependencies with Bun 1.3.14 and rebuilt the macOS arm64 native addon. The source-linked `omp` launcher now reports 18.12.6. Restart already-running OMP sessions after updating; the new native IPC API requires matching source/addon versions.

### Current verification

- Passed `check:types` for catalog, ai, tui and coding-agent; reran coding-agent after the final regression change.
- Passed the targeted customization batches: 105 TUI tests, 319 AI/catalog tests and 443 coding-agent tests. An additional 27-check run passed for file-paste ingestion (including the new guarded draft case), Cursor caller headers and the current docs generator/runtime contract; that run repeats the earlier file-paste suite.
- Passed the complete `ci:test:smoke` command after the native rebuild: version/help, stats help and native runtime smoke (`smoke-test: ok`). `omp models --help` still exposes the local probe command.
- A throwaway isolated HOME/config/session workspace exercised the actual CLI against a local HTTP/SSE provider: print-mode response, model selection, endpoint routing, auth header, and `models probe --json` successful health output with `applied:false`.
- Launched the actual terminal UI in an isolated pseudo-terminal; observed the model/footer, pasted-file attachment card/chip, and atomic Backspace removal. The scripted session was stopped by its timeout; this did not verify graceful interactive shutdown or the native desktop renderer.
- Loaded all 10 installed user extensions explicitly in an isolated CLI session and completed a local model turn (AgentRouter, Antigravity guard, context budget, director, guard, three Orca helpers, RTK and task-boundary). No load errors were reported. Installed extension files were not edited; live director workers/Orca integration were not exercised. None of those extension files calls `ui.approve()`; external custom UI hosts must still migrate its upstream boolean-to-choice contract.
- No live provider credentials/remote probes, full test suite, native desktop/hardware interaction, full skill-script sweep or historical stats backfill were verified. The OpenRouter usage provider and standalone UsagePanel remain unregistered/unmounted; the known stats backfill marker anomaly remains unchanged.

## Exact non-skill file inventory

Integrated-upstream-to-fork status (`A` added, `M` modified, `D` deleted): 121 non-skill paths, including changelogs, formatting and historical drift. The remaining 774 added skill assets are the `.omp/skills/**` group above; use the inventory command to expand them. This supersedes the previous v18.8.3 inventory.

```text
M	AGENTS.md
A	GUIDE.md
A	LOCAL_CHANGES.md
M	README.md
M	docs/keybindings.md
M	packages/ai/CHANGELOG.md
M	packages/ai/src/error/rate-limit.ts
M	packages/ai/src/providers/anthropic.ts
M	packages/ai/src/providers/cursor.ts
M	packages/ai/src/providers/openai-codex-responses.ts
M	packages/ai/src/providers/openai-completions.ts
M	packages/ai/src/providers/openai-responses.ts
M	packages/ai/src/providers/openai-shared.ts
A	packages/ai/src/registry/agentrouter.ts
A	packages/ai/src/registry/gorouter.ts
A	packages/ai/src/registry/justdowork.ts
A	packages/ai/src/registry/kktoken.ts
M	packages/ai/src/registry/registry.ts
A	packages/ai/src/registry/tabitoken.ts
A	packages/ai/src/registry/tokenforge.ts
A	packages/ai/src/usage/openrouter.ts
M	packages/ai/src/utils/schema/normalize.ts
M	packages/ai/test/auth-hooks-registry.test.ts
A	packages/ai/test/gateway-waf-headers.test.ts
M	packages/ai/test/openai-completions-compat.test.ts
M	packages/ai/test/schema-helpers.test.ts
M	packages/catalog/CHANGELOG.md
M	packages/catalog/package.json
M	packages/catalog/scripts/generate-models.ts
M	packages/catalog/src/compat/collapse.ts
M	packages/catalog/src/compat/resolve.ts
M	packages/catalog/src/compat/rules.json
M	packages/catalog/src/compat/rules/runtime/behavior.kdl
M	packages/catalog/src/compat/rules/taxonomy/_collapse.kdl
M	packages/catalog/src/discovery/cursor.ts
M	packages/catalog/src/discovery/protobuf.ts
M	packages/catalog/src/identity/id.ts
M	packages/catalog/src/index.ts
M	packages/catalog/src/model-thinking.ts
M	packages/catalog/src/models.ts
A	packages/catalog/src/openrouter-pricing-snapshot.json
A	packages/catalog/src/openrouter-pricing.ts
M	packages/catalog/src/provider-models/descriptors.ts
M	packages/catalog/src/provider-models/google.ts
M	packages/catalog/src/provider-models/openai-compat.ts
M	packages/catalog/src/wire/gemini-headers.ts
M	packages/catalog/test/build.test.ts
A	packages/catalog/test/openrouter-pricing.test.ts
M	packages/catalog/test/protobuf.test.ts
M	packages/coding-agent/CHANGELOG.md
A	packages/coding-agent/examples/extensions/agentrouter.ts
M	packages/coding-agent/src/cli/command-help.ts
M	packages/coding-agent/src/cli/help-extra.ts
M	packages/coding-agent/src/cli/models-cli.ts
M	packages/coding-agent/src/commands/models.ts
M	packages/coding-agent/src/config/model-registry.ts
M	packages/coding-agent/src/config/model-resolver.ts
M	packages/coding-agent/src/config/model-roles.ts
M	packages/coding-agent/src/config/models-config-schema-bundle.ts
A	packages/coding-agent/src/extensibility/extensions/agentrouter.ts
M	packages/coding-agent/src/extensibility/extensions/loader.ts
M	packages/coding-agent/src/extensibility/skills.ts
M	packages/coding-agent/src/main.ts
M	packages/coding-agent/src/modes/acp/acp-agent.ts
A	packages/coding-agent/src/modes/components/models-probe-panel.ts
A	packages/coding-agent/src/modes/components/usage-panel.ts
M	packages/coding-agent/src/modes/controllers/command-controller.ts
M	packages/coding-agent/src/modes/controllers/event-controller.ts
M	packages/coding-agent/src/modes/controllers/input-controller.ts
M	packages/coding-agent/src/modes/controllers/selector-controller.ts
M	packages/coding-agent/src/modes/interactive-mode.ts
M	packages/coding-agent/src/modes/rpc/rpc-mode.ts
M	packages/coding-agent/src/modes/skill-command.ts
M	packages/coding-agent/src/modes/types.ts
M	packages/coding-agent/src/session/agent-session-types.ts
M	packages/coding-agent/src/session/agent-session.ts
M	packages/coding-agent/src/session/agent-storage.ts
M	packages/coding-agent/src/session/model-controls.ts
M	packages/coding-agent/src/slash-commands/available-commands.ts
M	packages/coding-agent/src/slash-commands/builtin-marketplace.ts
M	packages/coding-agent/src/slash-commands/builtin-modes.ts
M	packages/coding-agent/src/slash-commands/helpers/stats-dashboard.ts
M	packages/coding-agent/src/tools/xdev.ts
M	packages/coding-agent/test/agent-session-model-persistence.test.ts
M	packages/coding-agent/test/agent-session-model-switch-auth.test.ts
M	packages/coding-agent/test/agent-session-role-thinking.test.ts
A	packages/coding-agent/test/guard-extension.test.ts
A	packages/coding-agent/test/input-controller-file-paste.test.ts
M	packages/coding-agent/test/issue-5764-registertool-loadmode.test.ts
M	packages/coding-agent/test/model-resolver.test.ts
A	packages/coding-agent/test/models-probe-all-apis.test.ts
A	packages/coding-agent/test/models-probe-cli.test.ts
A	packages/coding-agent/test/models-probe-panel.test.ts
M	packages/coding-agent/test/rpc-skill-command.test.ts
M	packages/coding-agent/test/skills.test.ts
A	packages/coding-agent/test/slash-commands/models-probe-dispatch.test.ts
M	packages/coding-agent/test/startup-composer.test.ts
M	packages/coding-agent/test/status-line-settings-cache.test.ts
A	packages/coding-agent/test/usage-panel.test.ts
M	packages/natives/native/vcs.js
M	packages/stats/src/db.ts
M	packages/stats/src/parser.ts
M	packages/tui/CHANGELOG.md
M	packages/tui/src/app-keybindings.ts
M	packages/tui/src/index.ts
A	packages/tui/src/native-modifiers.ts
M	packages/tui/src/overlays/model-browser.ts
M	packages/tui/src/overlays/model-picker.ts
M	packages/tui/src/prompt/attachment-chips.ts
M	packages/tui/src/prompt/composer-attachments.ts
M	packages/tui/src/prompt/composer.ts
M	packages/tui/src/prompt/custom-editor.ts
M	packages/tui/src/status-line/component.ts
M	packages/tui/src/status-line/types.ts
M	packages/tui/src/theme/symbols.ts
M	packages/tui/src/theme/theme-class.ts
M	packages/tui/test/attachment-chips.test.ts
M	packages/tui/test/custom-editor.test.ts
M	packages/utils/CHANGELOG.md
M	packages/utils/src/format.ts
M	packages/utils/src/sqlite.ts
```

