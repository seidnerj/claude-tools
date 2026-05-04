#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI entry point for the LLM safety check hook
//
// Requires: npm install -g tsx
//
// Usage: symlink this file and configure in ~/.claude/settings.json:
//   ln -s /path/to/claude-tools/src/bin/llm-safety-check.ts ~/.claude/hooks/llm-safety-check.ts
//
//   "hooks": {
//     "PreToolUse": [{
//       "matcher": "Bash|Edit|Write|WebFetch|WebSearch|Agent|NotebookEdit|mcp__.*",
//       "hooks": [{ "type": "command", "command": "tsx ~/.claude/hooks/llm-safety-check.ts", "timeout": 35 }]
//     }]
//   }
// ---------------------------------------------------------------------------

import { processHookInput } from "../llm-safety-check.js";
import type { HookInput } from "../types.js";

async function main(): Promise<void> {
    let raw = "";
    for await (const chunk of process.stdin) {
        raw += chunk;
    }

    let input: HookInput;
    try {
        input = JSON.parse(raw);
    } catch {
        process.stderr.write("LLM safety check: failed to parse stdin as JSON\n");
        process.exit(0);
    }

    const result = await processHookInput(input);

    if (!result) {
        // No decision or API failure - fall through to normal handling
        process.exit(0);
    }

    if (result.decision === "allow") {
        const output: Record<string, unknown> = {
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                permissionDecisionReason: result.reason,
                ...(result.additionalContext && { additionalContext: result.additionalContext }),
                ...(result.updatedInput && { updatedInput: result.updatedInput }),
            },
            // Optional top-level `usage` and `model` are emitted so any
            // consumer that recognizes them (e.g. an out-of-process hook-output
            // post-processor) can route them into CC's in-process spend
            // accumulator. Omitted on fast-path hits where no LLM ran.
            ...(result.usage && { usage: result.usage }),
            ...(result.model && { model: result.model }),
        };
        process.stdout.write(JSON.stringify(output) + "\n");
        process.exit(0);
    } else if (result.decision === "deny") {
        process.stderr.write(`Blocked by safety check: ${result.reason}\n`);
        // Even though deny exits non-zero (no JSON envelope is produced for
        // CC to parse), the API tokens spent reaching the deny verdict are
        // visible to the caller via the HookOutput.usage/model fields above
        // when wired into other transports.
        process.exit(2);
    }

    // Anything else - fall through
    process.exit(0);
}

main().catch((err) => {
    process.stderr.write(`LLM safety check error: ${err}\n`);
    process.exit(0);
});
