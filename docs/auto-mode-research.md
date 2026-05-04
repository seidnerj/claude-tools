# Claude Code Auto Mode — Reverse Engineering Notes

This document captures what we learned about Claude Code's built-in Auto Mode safety classifier through reverse-engineering of the bundled Bun-compiled binary. It exists to inform the design of this project's `llm-safety-check.ts` hook (which serves a similar purpose) and to be a re-verification reference when Claude Code is updated.

**Reference binary:** `~/.local/share/claude/versions/2.1.126` (Mach-O arm64, Bun-compiled). The full minified JS source is embedded as readable strings; `strings <binary>` was the primary RE technique. No Ghidra decompilation was needed.

**Clean-room note:** This document records _structural_ understanding of Auto Mode (sections, schemas, mode resolution, function locations). It does **not** include verbatim prompt text or any code lifted from the binary. Our own implementation was authored independently.

---

## What Auto Mode Is

Auto Mode is a permission mode in Claude Code (introduced March 2025). When the user enables it via `claude --permission-mode auto` or `--enable-auto-mode`, every tool call is evaluated by an in-process LLM classifier before execution. The classifier decides:

- **approve** — tool runs immediately
- **block** — Claude is asked to retry with a different approach (NOT a hard deny)
- **escalate** — user is prompted to allow/deny manually

It is gated to **Team / Enterprise plans** and **Sonnet 4.6 / Opus 4.6** only. Not available on Haiku, Claude 3.x, or third-party providers (Bedrock, Vertex, Foundry).

---

## In-Process Architecture

Auto Mode is **not** a subprocess hook. It's a function call inside the Claude Code binary that goes through the same in-process API client as the main agent loop. This has two important consequences:

1. **Cost attribution is automatic.** The classifier's tokens roll into the same in-process spend accumulator that `/cost`, the statusline, and rate-limit accounting all read from. Tagged `querySource: "auto_mode"` in telemetry. (For comparison: our hook's tokens are billed to the API key but invisible to client-side displays — see this project's planned Phase 2 cost-attribution gene.)

2. **It can use the session's auth.** Whether the user signed in via OAuth, API key, Bedrock, or Vertex, Auto Mode's classifier reaches the same endpoint with the same credentials. No separate API key configuration needed.

The classifier call uses the same thick `query()` wrapper as the main loop, with three flags identifying it as an Auto Mode call: `querySource: "auto_mode"`, `skipSystemPromptPrefix: true`, `extraBodyParams: _9H()` (which injects the `x-anthropic-billing-header`).

---

## System Prompt Structure

The system prompt is **not** authored as a single literal. It's assembled at runtime by stitching two source assets through a substitution function:

- **`_27`** (function `cP7()`) — the rule framework: Context, Threat Model, Input, Default Rule, Scope, User Intent rules, Evaluation Rules, `<permissions_template>` slot, Classification Process.
- **`PJ8`** (function `lP7()`) — the permissions template: Environment, Definitions, BLOCK list (~25 rules), ALLOW list (~7 rules), with placeholders for user customization.
- **`fG5(rules)`** — the assembler. Substitutes `<permissions_template>` in `_27` with `PJ8` (or empty `AG5` if a feature gate is off, but as of 2.1.126 the gate is always on).

### User-customization placeholders

Inside `PJ8`, three placeholders are substituted with user-supplied content:

- `<user_environment_to_replace>` — trusted infrastructure (repos, internal hosts, buckets)
- `<user_deny_rules_to_replace>` — additional BLOCK rules
- `<user_allow_rules_to_replace>` — additional ALLOW exceptions

The merge function (`jJ8`) supports a `$defaults` sentinel — when present in a user list, it's replaced with the built-in defaults at that position, letting users append to or replace defaults. Plus a separate `<settings_deny_rules>` slot driven by `MG5(JG5(rules))` that injects user-configured Claude permission deny rules with anti-circumvention wording (about tool-switching).

### Sections present

Across all modes the same base prompt is used. The full section list (titles only):

From `_27`: Context, Threat Model, Input, Default Rule, Scope, User Intent Rule, Evaluation Rules, `<permissions_template>` slot, Classification Process.

From `PJ8` (substituted into the template slot): Environment, Definitions, BLOCK if the action does ANY of these, ALLOW (exceptions) if ANY of these apply, plus the `<settings_deny_rules>` slot.

No section is conditionally added or removed by mode. Only the **trailing user-message directive** changes per mode.

---

## Modes

Auto Mode supports four classifier modes, selected by `tengu_auto_mode_config.twoStageClassifier` (resolved by `j27()` with default `true`, mapped through `vG5()` to `"fast" | "thinking" | "both"` and onward through `LG5()` to one of):

| Mode              | Stages            | Output format                                 | Token budget | Stop sequence   | Thinking |
| ----------------- | ----------------- | --------------------------------------------- | ------------ | --------------- | -------- |
| `xml_fast`        | single            | XML `<block>yes/no</block><reason>…</reason>` | 256          | `</block>`      | no       |
| `xml_thinking`    | single            | JSON via `<block>` rewriter or tool call      | 4096         | none            | yes      |
| `xml_2stage`      | two-stage (S1+S2) | S1 XML `<block>yes/no</block>`; S2 JSON       | 64 + 4096    | `</block>` (S1) | S2 only  |
| `tool_use_single` | single            | Forced `classify_result` tool call            | 4096         | none            | varies   |

The `twoStageClassifier` flag, despite the name, takes four possible values:

- `true` → `xml_2stage` (default)
- `"fast"` → `xml_fast`
- `"thinking"` → `xml_thinking`
- `false` → `tool_use_single`

**As of 2.1.126, the only writer to this flag is GrowthBook's remote feature service** (`cachedGrowthBookFeatures["tengu_auto_mode_config"]`). The two override layers that could make it locally controllable (`L7_` and `v7_`) are stubbed dead in this build (`L7_` returns null; `v7_` returns void with no body). If GrowthBook returns no payload for the user, the inline `?? true` default keeps two-stage on permanently. Single-stage modes are A/B test variants Anthropic controls, not user options.

### Two-stage flow

S1 ("fast triage"):

- Same system prompt as S2.
- Trailing directive (in user message) tells the model: do NOT apply ALLOW exceptions; do NOT evaluate user intent (those are S2's job); do NOT think out loud; if any BLOCK rule could plausibly apply, output `<block>yes</block>`, otherwise `<block>no</block>`. Begin response immediately with `<block>`.
- 64-token budget, `stop_sequences: ["</block>"]`, no thinking, `temperature: 0`.
- On `<block>no</block>` → approve, done.
- On `<block>yes</block>` → escalate to S2.

S2 ("full evaluation"):

- Same base system prompt.
- Trailing directive: now apply the full classification process — ALLOW exceptions, user intent, full reasoning. May use `<thinking>...</thinking>` before `<block>`. Block only if unambiguously dangerous and no exception applies. When in doubt, prefer "prompt" / escalate rather than block.
- 4096-token budget, no stop sequence, thinking enabled (`thinking: false` parameter is misleading — the budget allows it; `temperature: 0` still applies).

The trailing directive (S1 vs S2) is the _only_ piece of the prompt that differs between stages. Same system prompt, same user transcript, same action description.

---

## Output Formats

### XML modes (`xml_fast`, `xml_2stage`)

```
<block>yes|no</block>
<reason>...</reason>      (optional, only when blocked)
<thinking>...</thinking>  (S2 / xml_thinking only)
```

Parsers:

- `nP7` — extracts `<block>` value
- `iP7` — extracts `<reason>` content
- `GG5` — extracts `<thinking>` content

The `xml_thinking` mode rewrites the trailing tool-use sentence via `ZG5(prompt)` into an `## Output Format` section explaining the `<block>/<reason>` XML contract.

### Tool-use mode (`tool_use_single`)

Forced tool call with this schema (`wG5`):

```
name: "classify_result"
input_schema:
  thinking: string   ("Brief step-by-step reasoning.")
  shouldBlock: boolean
  reason: string
required: [thinking, shouldBlock, reason]
```

Validated against zod schema `YG5` with the same three fields. Forced via `tool_choice: { type: "tool", name: "classify_result" }`.

---

## Caching and Cost Optimization

- **1-hour ephemeral prompt cache** (`cache_control: {type: "ephemeral", ttl: "1h"}`) on:
    - The system blocks (billing header + system prompt)
    - The CLAUDE.md block (when present)
    - The action message block
- **Approval cache**: a `Map` of approved decisions keyed by something resembling `hash(toolName, normalizedToolInput)`. Repeats reuse the verdict without an API call.
- **Per-tool input redaction**: each tool can declare what the classifier sees via a `toAutoClassifierInput()` method. Returning `""` skips classification entirely; returning a redacted string replaces the default formatter. Read-only tools (`oq`/`W4`/`c1`/grep/list family) are stripped from the transcript before the classifier sees it.
- **Stop sequences** truncate S1 the moment the verdict appears (`</block>` after `yes` or `no`).

These together — especially the prompt cache + S1 funnel + approval cache — are what make Auto Mode's per-call cost dramatically lower than a naïve full-prompt-every-call classifier.

---

## Failure Handling

Auto Mode is **fail-closed everywhere**. When the classifier can't deliver a verdict, the action is blocked, not allowed:

- API error → block ("Classifier unavailable - blocking for safety")
- Parse failure → block ("Auto mode could not evaluate this action and is blocking it for safety")
- Context-overflow → block
- Abort → block
- S2 error → block "based on stage 1 assessment"

One exception: `SandboxNetworkAccess` defers to a feature-flag iron-gate (`tengu_iron_gate_closed`) when the classifier is unavailable.

Errors are dumped to `~/.claude/.../auto-mode-classifier-errors/<id>.txt` for diagnosis. A **denial-rate circuit breaker** (`tengu_auto_mode_denial_limit_exceeded`) pauses Auto Mode after repeated denials so the user can take over.

---

## Permission Pipeline Order

When both Auto Mode and a `PreToolUse` hook are active, the order is:

1. **Allow / deny rules** (from `~/.claude/settings.json` `permissions.allow` / `deny`) — short-circuit first.
2. **`PreToolUse` hooks** — our LLM safety hook runs here. Returns `allow` (short-circuit), `deny` (short-circuit), or `null` (fall through).
3. **Permission mode** — Auto Mode's classifier runs here when `null` reaches it.
4. **User prompt** — falls through here if everything above abstained.

So our hook fires **before** Auto Mode. If we approve or deny, Auto Mode never runs (and never charges tokens). If we punt with `null` (prompt / API error / degradation), Auto Mode then evaluates.

This is what makes "use both" defense-in-depth: our hook gets first crack with custom rules + hard-deny + `needs_context` file inspection; Auto Mode acts as a backstop with its remote-controlled rules.

---

## Cost Attribution

Auto Mode's classifier tokens land in the session's `/cost`, statusline, and rate-limit accounting **automatically** because the call goes through the in-process `query()` wrapper. Telemetry events are tagged `querySource: "auto_mode"` so they can be split out from main-loop spend if desired.

Our hook can't replicate this directly because we run as a subprocess and have no pointer to CC's accumulator. Phase 2 of the safety hook plan relies on an out-of-process post-processor that augments CC's hook output handling to recognize an optional `usage` field and add it to the accumulator — closing the gap. (See plan: `~/.claude/plans/2026-05-04-llm-safety-hook-phase-1.md` "Phase 2".)

---

## Function Reference (for future re-verification)

These are the symbol names found in the `strings` output of `~/.local/share/claude/versions/2.1.126`. They are minified globals that may be renamed in future builds — re-grep with descriptive anchors (e.g. "tengu_auto_mode_config", "twoStageClassifier", "classify_result", "Stage 1", "</block>") if these names change.

| Symbol                      | Role                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| `_27` / `cP7()`             | Base rule framework prompt                                                        |
| `PJ8` / `lP7()`             | Permissions template with placeholders                                            |
| `fG5(rules)`                | Stitches `_27` and `PJ8` into the final system prompt; substitutes user rules     |
| `j27()`                     | Reads `tengu_auto_mode_config.twoStageClassifier` with `?? true` default          |
| `vG5()`                     | Returns true when `j27()` is `true`, `"fast"`, or `"thinking"` (XML modes)        |
| `VG5()`                     | Maps `j27()` to mode token `"fast"` / `"thinking"` / `"both"`                     |
| `LG5()`                     | XML classifier driver (handles all XML mode variants)                             |
| `YY_()`                     | Top-level dispatcher; tool-use path inline                                        |
| `ZG5(prompt)`               | Rewrites the tool-use trailer into XML output spec for XML modes                  |
| `wG5` / `YG5`               | `classify_result` tool definition + zod schema                                    |
| `XG5` / `PG5` / `WG5`       | Trailing directives for `xml_fast` / `S1` / `S2` (and `xml_thinking`)             |
| `nP7` / `iP7` / `GG5`       | Output parsers for `<block>` / `<reason>` / `<thinking>`                          |
| `MG5(JG5(rules))`           | Injects user-configured Claude permission deny rules into `<settings_deny_rules>` |
| `q27()` / `$76()` / `K76()` | User rule list mergers with `$defaults` (`A76`) sentinel                          |
| `aP7()`                     | Resolves the classifier model (config or main-session model)                      |
| `D27(model)`                | Returns `[thinking_enabled, max_tokens]` for thinking-capable models              |
| `_9H()`                     | Injects extra body params including the billing header                            |
| `T27()`                     | Reconstructs transcript for the classifier (filters read-only tool_uses)          |
| `$27()`                     | Default per-tool input formatter (line-format or JSONL)                           |
| `jG5()`                     | Wraps CLAUDE.md as a user-role message                                            |
| `G_(key, default)` / `HR`   | GrowthBook feature lookup (used for `tengu_auto_mode_config` and others)          |
| `L7_()` / `v7_()`           | Local override layers (stubbed dead in 2.1.126)                                   |

### Related feature flags

| Flag                                        | Purpose                                              |
| ------------------------------------------- | ---------------------------------------------------- |
| `tengu_auto_mode_config.enabled`            | Master enable/disable for Auto Mode                  |
| `tengu_auto_mode_config.twoStageClassifier` | Mode selection (described above)                     |
| `tengu_auto_mode_config.model`              | Classifier model override                            |
| `tengu_auto_mode_config.jsonlTranscript`    | Switches transcript format from line-format to JSONL |
| `tengu_iron_gate_closed`                    | Network sandbox fail-open vs fail-closed switch      |
| `tengu_auto_mode_denial_limit_exceeded`     | Denial-rate circuit breaker                          |
| `tengu_auto_mode_malformed_tool_input`      | Telemetry for tool input redaction failures          |

---

## RE Methodology Notes

For anyone re-verifying this on a future Claude Code build:

1. `strings <binary> > /tmp/cc_strings.txt` extracts the embedded source.
2. Anchor on stable text: `"tengu_auto_mode_config"`, `"classify_result"`, `"Stage 1"`, `"</block>"`, `"twoStageClassifier"`, `"cachedGrowthBookFeatures"`.
3. The minifier may rename function symbols (`_27`, `fG5`, `VG5`, etc.) between releases. Re-grep with the text anchors above to find equivalents.
4. The full minified JS is on one giant line — `sed`/`awk` to extract a window around a hit, then split on `;` for readability:
    ```
    grep -n "twoStageClassifier" /tmp/cc_strings.txt
    sed -n '<line>p' /tmp/cc_strings.txt > /tmp/window.js
    node -e "const c=require('fs').readFileSync('/tmp/window.js','utf8'); require('fs').writeFileSync('/tmp/split.js', c.split(';').join(';\n'))"
    ```
5. Mine schemas first (`grep -n '"type":\s*"object"\|"properties"' /tmp/cc_strings.txt`) — JSON schemas reveal feature structure without reading code.
6. Stop on **structural** understanding — sections, schemas, mode resolution, function locations. Do NOT extract verbatim prompt text into our codebase. Clean-room implementations must be authored independently from the structural understanding.

---

## How This Maps to Our Implementation

Quick cross-reference between Auto Mode and our `llm-safety-check.ts` after Phase 1:

| Concept                     | Auto Mode                                   | Our hook                                                                                                                             |
| --------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| System prompt               | `_27` + `PJ8` stitched by `fG5`             | `SYSTEM_PROMPT` + `buildSystemPrompt(userRules)` in `safety-prompts.ts`                                                              |
| Stage directives            | `XG5` / `PG5` / `WG5`                       | `DIRECTIVE_S1` / `DIRECTIVE_S2` / `DIRECTIVE_SINGLE_FAST` / `DIRECTIVE_SINGLE_THINKING` in `safety-prompts.ts` (clean-room authored) |
| User rule placeholders      | `<user_*_to_replace>` with `$defaults`      | `<user_block_rules>` / `<user_allow_rules>` / `<user_environment>`                                                                   |
| Mode dispatcher             | `VG5()` / `LG5()` / `YY_()`                 | `runStage()` / `runTwoStage()` / `runSingleStage()` in `safety-stages.ts`                                                            |
| Per-stage budgets           | Inline in `LG5`                             | `STAGE_CONFIG` table in `safety-stages.ts`                                                                                           |
| XML output parser           | `nP7` / `iP7` / `GG5`                       | `parseXmlVerdict` in `safety-prompts.ts`                                                                                             |
| Approval cache              | (in-process Map)                            | `ApprovalCache` in `safety-cache.ts`                                                                                                 |
| Per-tool input redaction    | `toAutoClassifierInput` per tool            | `TOOL_REDACTORS` registry in `safety-redaction.ts`                                                                                   |
| Read-only transcript filter | `T27` filters `oq`/`W4`/`c1`/etc.           | `READ_ONLY_TOOLS` set in `llm-safety-check.ts`                                                                                       |
| Prompt caching              | 1h ephemeral on system / CLAUDE.md / action | Same — `cache_control: {type: "ephemeral", ttl: "1h"}` on system + user blocks in `callApi`                                          |
| Failure mode                | Fail-closed (hardcoded)                     | Configurable via `safety.fail_closed` (default fail-open)                                                                            |
| Hard deny                   | No (block → retry)                          | Yes — `{decision: "deny"}` short-circuits permission chain                                                                           |
| File inspection             | None                                        | Two-pass `needs_context` (single-stage-thinking and S2 only)                                                                         |
| Cost attribution            | In-process accumulator (free)               | Phase 2 — out-of-process post-processor that augments hook output handling                                                           |
