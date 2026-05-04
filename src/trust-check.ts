import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Workspace trust prediction.
//
// Mirrors claude's Qw1() and SIH() (workspace-trust check + project-root
// detection) as of claude version 2.1.126. Full byte-for-byte replication
// including the t$() project-root resolver:
//
//   1. findGitRoot: parent-walks for .git (file or directory)
//   2. resolveWorktreeToMainRepo: if .git is a worktree marker file, reads
//      gitdir/commondir, validates the round-trip, and resolves to the
//      main repo path
//   3. The trust check first looks up projects[<projectRoot>] then walks
//      parents from the workspace path
//
// If claude updates its trust algorithm, run `npm run test:drift` to detect
// divergence and update this file.
// ---------------------------------------------------------------------------

const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);

function findGitRoot(cwd: string): string | null {
    let dir = path.resolve(cwd);
    const root = path.parse(dir).root;
    while (true) {
        const gitPath = path.join(dir, ".git");
        try {
            const stat = fsSync.statSync(gitPath);
            if (stat.isDirectory() || stat.isFile()) {
                return dir.normalize("NFC");
            }
        } catch {
            // .git doesn't exist here; continue walking up
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // Final check at the actual root (handles edge case where root itself contains .git)
    try {
        const stat = fsSync.statSync(path.join(root, ".git"));
        if (stat.isDirectory() || stat.isFile()) return root.normalize("NFC");
    } catch {
        // ignore
    }
    return null;
}

function resolveWorktreeToMainRepo(gitRoot: string): string {
    try {
        const dotGit = path.join(gitRoot, ".git");
        const raw = fsSync.readFileSync(dotGit, "utf-8").trim();
        if (!raw.startsWith("gitdir:")) {
            // .git is a directory (regular repo) - readFileSync would have thrown EISDIR
            // and we'd be in the catch. If we're here with a non-"gitdir:" line, treat
            // as malformed and return gitRoot unchanged.
            return gitRoot;
        }
        const gitdirRel = raw.slice("gitdir:".length).trim();
        const absGitdir = path.resolve(gitRoot, gitdirRel);

        // Read <absGitdir>/commondir to find the main repo's .git
        const commondirRel = fsSync.readFileSync(path.join(absGitdir, "commondir"), "utf-8").trim();
        const commonDir = path.resolve(absGitdir, commondirRel);

        // Safety check 1: parent of absGitdir must be <commonDir>/worktrees
        if (path.resolve(path.dirname(absGitdir)) !== path.join(commonDir, "worktrees")) {
            return gitRoot;
        }

        // Safety check 2: <absGitdir>/gitdir must round-trip back to <gitRoot>/.git via realpath
        const gitdirPointer = fsSync.readFileSync(path.join(absGitdir, "gitdir"), "utf-8").trim();
        if (fsSync.realpathSync(gitdirPointer) !== fsSync.realpathSync(dotGit)) {
            return gitRoot;
        }

        // commonDir is normally <main-repo>/.git - return its parent (the main repo)
        if (path.basename(commonDir) !== ".git") {
            return commonDir.normalize("NFC");
        }
        return path.dirname(commonDir).normalize("NFC");
    } catch {
        // Any read/parse failure: fall back to gitRoot
        return gitRoot;
    }
}

export function findProjectRoot(workspace: string): string | null {
    const gitRoot = findGitRoot(workspace);
    if (!gitRoot) return null;
    return resolveWorktreeToMainRepo(gitRoot);
}

export async function willHitTrustDialog(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (TRUTHY_ENV.has(String(env.CLAUDE_CODE_SANDBOXED ?? "").toLowerCase())) return false;
    if (env.CLAUDE_BG_BACKEND === "daemon") return false;

    let projects: Record<string, { hasTrustDialogAccepted?: boolean }> = {};
    try {
        const raw = await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8");
        projects = (JSON.parse(raw) as { projects?: typeof projects }).projects ?? {};
    } catch {
        return true;
    }

    // Project-root check (mirrors claude's SIH() lookup)
    const projectRoot = findProjectRoot(workspace) ?? path.resolve(workspace).normalize("NFC");
    if (projects[projectRoot]?.hasTrustDialogAccepted === true) return false;

    // Parent walk (mirrors claude's while-loop after the SIH lookup)
    let p = path.resolve(workspace).normalize("NFC");
    while (true) {
        if (projects[p]?.hasTrustDialogAccepted === true) return false;
        const parent = path.resolve(p, "..").normalize("NFC");
        if (parent === p) return true;
        p = parent;
    }
}

/** Standard error thrown by openSession when the workspace is not trusted. */
export class WorkspaceNotTrustedError extends Error {
    readonly workspace: string;
    constructor(workspace: string) {
        super(
            `Workspace not trusted: ${workspace}. Run \`claude\` in that directory once ` +
                `to review and accept the workspace trust dialog, then retry openSession.`
        );
        this.name = "WorkspaceNotTrustedError";
        this.workspace = workspace;
    }
}
