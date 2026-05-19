// ---------------------------------------------------------------------------
// Optional SIGUSR1 prompt-redraw hook for ~/.zshrc.
// Allows background processes (like the async envrc spend banner) to trigger
// a clean zsh prompt redraw after printing to /dev/tty.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ZSH_HOOK_MARKER = "# claude-tools: async prompt redraw";
const ZSH_HOOK_SNIPPET = `${ZSH_HOOK_MARKER}
TRAPUSR1() { if [[ -o zle ]]; then zle reset-prompt; fi }
: > "/tmp/.claude-tools-usr1-$$"`;

function zshrcPath(): string {
    return path.join(process.env.HOME || os.homedir(), ".zshrc");
}

export function hasZshHook(): boolean {
    const zshrc = zshrcPath();
    if (!fs.existsSync(zshrc)) return false;
    return fs.readFileSync(zshrc, "utf-8").includes(ZSH_HOOK_MARKER);
}

export function installZshHook(): { installed: boolean; alreadyPresent: boolean } {
    if (hasZshHook()) return { installed: false, alreadyPresent: true };
    const zshrc = zshrcPath();
    const existing = fs.existsSync(zshrc) ? fs.readFileSync(zshrc, "utf-8") : "";
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : "\n";
    fs.appendFileSync(zshrc, `${separator}${ZSH_HOOK_SNIPPET}\n`);
    return { installed: true, alreadyPresent: false };
}
