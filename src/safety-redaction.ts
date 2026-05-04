// ---------------------------------------------------------------------------
// Per-tool input redaction + fast-path allowlist
// ---------------------------------------------------------------------------
//
// Redaction lets each tool declare what the safety classifier sees:
//   - returning null = skip classification entirely (fast-approve)
//   - returning a string = use this as the classifier input (instead of the default)
//   - not registered = fall through to generic formatToolInput
//
// Composes with the regex allowlist for Bash and the cwd-local check for Edit/Write.

import * as path from "node:path";

export type ToolRedactor = (input: Record<string, unknown>) => string | null | undefined;

const SAFE_BASH_PREFIXES: RegExp[] = [
    /^(ls|ll|la)\b/,
    /^(cat|head|tail|less|more|wc|file|stat)\b/,
    /^(which|whereis|type|command\s+-v)\b/,
    /^(echo|printf)\b/,
    /^(pwd|whoami|hostname|uname|date|uptime|df|du)\b/,
    /^(env|printenv|locale)\b/,
    /^git\s+(status|log|diff|show|branch|tag|remote|describe|rev-parse|ls-files|ls-tree|shortlog|stash\s+list)\b/,
    /^(npm\s+(test|run\s+(test|lint|build|check)|ls|list|outdated|audit|pack|explain|why))\b/,
    /^(npx\s+(vitest|jest|tsc|eslint|prettier)\b)/,
    /^(vitest|jest|pytest|cargo\s+test|cargo\s+check|go\s+test|go\s+vet|make\s+test|make\s+check)\b/,
    /^(tsc\s+--noEmit|eslint\s|prettier\s+--check)\b/,
    /^(node|tsx|bun)\s+(-e|--eval|-p|--print)\b/,
    /^(python3?|ruby|perl)\s+(-c\s|--version|-V)\b/,
    /^(npm|node|bun|python3?|ruby|cargo|go|java|javac|gcc|g\+\+|clang|make|cmake)\s+--?(version|help)\b/,
];

const UNSAFE_BASH_CHARS = /[|>]|`|\$\(/;

/**
 * Per-tool redactors. Returning null means "skip classification" (fast-approve).
 * Returning a string means "use this string as the classifier input".
 * Not registered means "use the default formatter".
 */
export const TOOL_REDACTORS: Record<string, ToolRedactor> = {
    Glob: () => null,
    LS: () => null,
    NotebookRead: () => null,
    Read: () => null,
    Grep: () => null,
    TodoWrite: () => null,
    BashOutput: () => null,
};

/**
 * Check if a tool use can be fast-approved without calling the LLM.
 * Returns a reason string if fast-approved, or null if the LLM should evaluate.
 */
export function isFastApprove(toolName: string, toolInput: Record<string, unknown>, cwd?: string): string | null {
    const redactor = TOOL_REDACTORS[toolName];
    if (redactor) {
        const result = redactor(toolInput);
        if (result === null) return `Tool ${toolName} is read-only or stateless`;
    }

    if ((toolName === "Edit" || toolName === "Write") && cwd) {
        const filePath = toolInput.file_path as string | undefined;
        if (filePath) {
            const resolved = path.resolve(filePath);
            const resolvedCwd = path.resolve(cwd);
            if (resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd) {
                return `Local ${toolName.toLowerCase()} operation in working directory`;
            }
        }
        return null;
    }

    if (toolName === "Bash") {
        const command = ((toolInput.command as string) ?? "").trim();
        if (!command) return null;
        if (UNSAFE_BASH_CHARS.test(command)) return null;
        for (const pattern of SAFE_BASH_PREFIXES) {
            if (pattern.test(command)) return "Known-safe read-only command";
        }
    }
    return null;
}

/**
 * Format a tool input for the classifier. If a per-tool redactor returns a string,
 * that's used directly. Otherwise the per-tool default formatter (Bash, Edit, Write,
 * WebFetch, WebSearch, Agent) runs. Anything else falls back to JSON.
 */
export function formatToolInput(toolName: string, toolInput: Record<string, unknown>): string {
    const redactor = TOOL_REDACTORS[toolName];
    if (redactor) {
        const result = redactor(toolInput);
        if (typeof result === "string") return result;
    }

    if (toolName === "Bash") {
        const command = (toolInput.command as string) ?? "";
        const description = (toolInput.description as string) ?? "";
        return (
            `<untrusted-command>\n${command}\n</untrusted-command>\n` +
            `<untrusted-description>\n${description || "(none provided)"}\n</untrusted-description>`
        );
    }
    if (toolName === "Edit") {
        const filePath = (toolInput.file_path as string) ?? "";
        const oldStr = (toolInput.old_string as string) ?? "";
        const newStr = (toolInput.new_string as string) ?? "";
        const replaceAll = toolInput.replace_all ? " (replace all)" : "";
        return `File: ${filePath}${replaceAll}\n<old_string>\n${oldStr}\n</old_string>\n<new_string>\n${newStr}\n</new_string>`;
    }
    if (toolName === "Write") {
        const filePath = (toolInput.file_path as string) ?? "";
        const content = (toolInput.content as string) ?? "";
        const truncated = content.length > 5000 ? content.slice(0, 5000) + "\n... (truncated)" : content;
        return `File: ${filePath}\n<content>\n${truncated}\n</content>`;
    }
    if (toolName === "WebFetch") {
        return `URL: ${(toolInput.url as string) ?? ""}\nPrompt: ${(toolInput.prompt as string) ?? ""}`;
    }
    if (toolName === "WebSearch") {
        return `Query: ${(toolInput.query as string) ?? ""}`;
    }
    if (toolName === "Agent") {
        const prompt = (toolInput.prompt as string) ?? "";
        const subType = (toolInput.subagent_type as string) ?? "";
        return `Subagent type: ${subType || "general-purpose"}\n<prompt>\n${prompt}\n</prompt>`;
    }
    return JSON.stringify(toolInput, null, 2);
}
