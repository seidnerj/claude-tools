import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);

/**
 * Predict whether `claude --rc` launched in `workspace` would show the trust dialog.
 *
 * Returns `true` if the dialog WOULD appear (workspace not trusted).
 * Returns `false` if the dialog would be skipped (trusted, or env bypass).
 *
 * Mirrors claude's Qw1() (workspace-trust check) as of claude version 2.1.126.
 * Conservative subset: parent-walks projects[].hasTrustDialogAccepted; does NOT
 * replicate claude's project-root detection (t$()), so this errs toward
 * "untrusted" when claude might find a trusted ancestor via project-root
 * resolution we don't model. False-positive refusals are bounded UX failures;
 * false-negative approvals cannot occur (our walk is a strict subset of
 * claude's lookup).
 */
export async function willHitTrustDialog(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (TRUTHY_ENV.has(String(env.CLAUDE_CODE_SANDBOXED ?? "").toLowerCase())) return false;
    if (env.CLAUDE_BG_BACKEND === "daemon") return false;

    let projects: Record<string, { hasTrustDialogAccepted?: boolean }> = {};
    try {
        const raw = await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8");
        const parsed = JSON.parse(raw) as { projects?: typeof projects };
        projects = parsed.projects ?? {};
    } catch {
        return true;
    }

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
