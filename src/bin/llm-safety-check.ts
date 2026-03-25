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
        };
        process.stdout.write(JSON.stringify(output) + "\n");
        process.exit(0);
    } else if (result.decision === "deny") {
        process.stderr.write(`Blocked by safety check: ${result.reason}\n`);
        process.exit(2);
    }

    // Anything else - fall through
    process.exit(0);
}

main().catch((err) => {
    process.stderr.write(`LLM safety check error: ${err}\n`);
    process.exit(0);
});
