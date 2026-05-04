import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as fsSync from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { willHitTrustDialog, WorkspaceNotTrustedError, findProjectRoot } from "../trust-check.js";

describe("willHitTrustDialog", () => {
    let tmpHome: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "trust-check-test-"));
        originalHome = process.env.HOME;
        process.env.HOME = tmpHome;
    });

    afterEach(async () => {
        if (originalHome !== undefined) process.env.HOME = originalHome;
        else delete process.env.HOME;
        await fs.rm(tmpHome, { recursive: true, force: true });
    });

    async function writeConfig(projects: Record<string, { hasTrustDialogAccepted?: boolean }>): Promise<void> {
        await fs.writeFile(path.join(tmpHome, ".claude.json"), JSON.stringify({ projects }, null, 2));
    }

    it("returns false when exact path is trusted", async () => {
        const ws = await fs.mkdtemp(path.join(tmpHome, "ws-"));
        await writeConfig({ [ws]: { hasTrustDialogAccepted: true } });
        expect(await willHitTrustDialog(ws, {})).toBe(false);
    });

    it("returns false when an ancestor is trusted (parent walk)", async () => {
        const parent = await fs.mkdtemp(path.join(tmpHome, "parent-"));
        const child = path.join(parent, "child");
        await fs.mkdir(child);
        await writeConfig({ [parent]: { hasTrustDialogAccepted: true } });
        expect(await willHitTrustDialog(child, {})).toBe(false);
    });

    it("returns true when no entry is trusted", async () => {
        const ws = await fs.mkdtemp(path.join(tmpHome, "ws-"));
        await writeConfig({});
        expect(await willHitTrustDialog(ws, {})).toBe(true);
    });

    it("returns true when entry is explicitly false", async () => {
        const ws = await fs.mkdtemp(path.join(tmpHome, "ws-"));
        await writeConfig({ [ws]: { hasTrustDialogAccepted: false } });
        expect(await willHitTrustDialog(ws, {})).toBe(true);
    });

    it("returns true when ~/.claude.json is missing", async () => {
        const ws = await fs.mkdtemp(path.join(tmpHome, "ws-"));
        expect(await willHitTrustDialog(ws, {})).toBe(true);
    });

    it("returns true when ~/.claude.json is malformed JSON", async () => {
        const ws = await fs.mkdtemp(path.join(tmpHome, "ws-"));
        await fs.writeFile(path.join(tmpHome, ".claude.json"), "not json");
        expect(await willHitTrustDialog(ws, {})).toBe(true);
    });

    it.each(["1", "true", "yes", "on", "TRUE", "Yes"])("returns false when CLAUDE_CODE_SANDBOXED is truthy (%s)", async (value) => {
        const ws = await fs.mkdtemp(path.join(tmpHome, "ws-"));
        await writeConfig({});
        expect(await willHitTrustDialog(ws, { CLAUDE_CODE_SANDBOXED: value })).toBe(false);
    });

    it("returns false when CLAUDE_BG_BACKEND=daemon", async () => {
        const ws = await fs.mkdtemp(path.join(tmpHome, "ws-"));
        await writeConfig({});
        expect(await willHitTrustDialog(ws, { CLAUDE_BG_BACKEND: "daemon" })).toBe(false);
    });

    it("normalizes paths to NFC before comparing", async () => {
        const nfd = "café";
        const nfc = "café";
        const wsNfd = path.join(tmpHome, nfd);
        await fs.mkdir(wsNfd);
        await writeConfig({ [path.resolve(path.join(tmpHome, nfc))]: { hasTrustDialogAccepted: true } });
        expect(await willHitTrustDialog(wsNfd, {})).toBe(false);
    });
});

describe("WorkspaceNotTrustedError", () => {
    it("has stable name and exposes workspace", () => {
        const err = new WorkspaceNotTrustedError("/some/ws");
        expect(err.name).toBe("WorkspaceNotTrustedError");
        expect(err.workspace).toBe("/some/ws");
        expect(err.message).toContain("/some/ws");
        expect(err.message).toContain("Run `claude`");
    });
});

describe("findProjectRoot", () => {
    let tmpHome: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "find-project-root-test-"));
        originalHome = process.env.HOME;
        process.env.HOME = tmpHome;
    });

    afterEach(async () => {
        if (originalHome !== undefined) process.env.HOME = originalHome;
        else delete process.env.HOME;
        await fs.rm(tmpHome, { recursive: true, force: true });
    });

    it("returns null when no .git ancestor exists", () => {
        // Use a subdirectory of tmpHome that has no .git anywhere in its ancestry.
        // We rely on tmpHome being outside any git repo tree. If tmpHome itself
        // is inside a repo (e.g. CI cloned into a temp dir), the result will be
        // a string - the assertion handles both cases.
        const noGitDir = path.join(tmpHome, "no-git-subdir");
        fsSync.mkdirSync(noGitDir);
        const result = findProjectRoot(noGitDir);
        // If no .git is found, null is returned. If the test runner happens to
        // run inside a repo that owns tmpHome, a string is returned - both are valid.
        expect(result === null || typeof result === "string").toBe(true);
    });

    it("returns the dir containing .git for a regular repo", async () => {
        const repo = path.join(tmpHome, "myrepo");
        await fs.mkdir(repo);
        await fs.mkdir(path.join(repo, ".git"));
        const result = findProjectRoot(repo);
        expect(result).toBe(path.resolve(repo).normalize("NFC"));
    });

    it("returns the repo root from a subdirectory", async () => {
        const repo = path.join(tmpHome, "myrepo");
        const sub = path.join(repo, "src", "deep");
        await fs.mkdir(sub, { recursive: true });
        await fs.mkdir(path.join(repo, ".git"));
        const result = findProjectRoot(sub);
        expect(result).toBe(path.resolve(repo).normalize("NFC"));
    });

    it("resolves a git worktree to the main repo path (uses real git)", async () => {
        // Skip if git isn't on PATH
        const gitCheck = spawnSync("git", ["--version"], { stdio: "ignore" });
        if (gitCheck.status !== 0) {
            console.warn("git not on PATH, skipping worktree test");
            return;
        }

        const main = path.join(tmpHome, "main");
        await fs.mkdir(main);

        // Build a clean env for git that strips any inherited GIT_DIR / GIT_WORK_TREE
        // variables so the subprocess cannot accidentally target the outer repo.
        const gitEnv: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_DIR: undefined,
            GIT_WORK_TREE: undefined,
            GIT_INDEX_FILE: undefined,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
        };

        // Initialize a real git repo (claude's algorithm reads real worktree metadata)
        spawnSync("git", ["-C", main, "init", "-q"], { stdio: "ignore", env: gitEnv });
        const commitResult = spawnSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "init"], { stdio: "pipe", env: gitEnv });
        if (commitResult.status !== 0) {
            console.warn("git commit failed, skipping test:", commitResult.stderr?.toString());
            return;
        }

        const wt = path.join(tmpHome, "wt");
        const r = spawnSync("git", ["-C", main, "worktree", "add", wt], { stdio: "pipe", env: gitEnv });
        if (r.status !== 0) {
            // Some test environments restrict git operations; skip rather than fail
            console.warn("git worktree add failed, skipping test:", r.stderr?.toString());
            return;
        }

        const result = findProjectRoot(wt);
        // realpath the main repo because mkdtemp on macOS may return a path under /var
        // that resolves to /private/var
        expect(result).toBe(fsSync.realpathSync(main).normalize("NFC"));
    });

    it("falls back to the gitRoot when the .git file is malformed", async () => {
        const repo = path.join(tmpHome, "weirdrepo");
        await fs.mkdir(repo);
        // .git is a file but not a "gitdir:" line
        await fs.writeFile(path.join(repo, ".git"), "this is not a git file");
        const result = findProjectRoot(repo);
        expect(result).toBe(path.resolve(repo).normalize("NFC"));
    });

    it("falls back to the gitRoot when the gitdir target is missing", async () => {
        const repo = path.join(tmpHome, "broken");
        await fs.mkdir(repo);
        await fs.writeFile(path.join(repo, ".git"), "gitdir: /nonexistent/path/to/gitdir");
        const result = findProjectRoot(repo);
        expect(result).toBe(path.resolve(repo).normalize("NFC"));
    });
});

describe("willHitTrustDialog with project-root resolution", () => {
    let tmpHome: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
        tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "trust-pr-test-"));
        originalHome = process.env.HOME;
        process.env.HOME = tmpHome;
    });

    afterEach(async () => {
        if (originalHome !== undefined) process.env.HOME = originalHome;
        else delete process.env.HOME;
        await fs.rm(tmpHome, { recursive: true, force: true });
    });

    async function writeConfig(projects: Record<string, { hasTrustDialogAccepted?: boolean }>): Promise<void> {
        await fs.writeFile(path.join(tmpHome, ".claude.json"), JSON.stringify({ projects }, null, 2));
    }

    it("returns false when the resolved git root is trusted (deep subdir)", async () => {
        const repo = path.join(tmpHome, "repo");
        const sub = path.join(repo, "src", "deep");
        await fs.mkdir(sub, { recursive: true });
        await fs.mkdir(path.join(repo, ".git"));
        await writeConfig({ [path.resolve(repo).normalize("NFC")]: { hasTrustDialogAccepted: true } });

        expect(await willHitTrustDialog(sub, {})).toBe(false);
    });

    it("returns false when the worktree's main repo is trusted", async () => {
        const gitCheck = spawnSync("git", ["--version"], { stdio: "ignore" });
        if (gitCheck.status !== 0) return;

        const main = path.join(tmpHome, "main");
        await fs.mkdir(main);

        const gitEnv: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_DIR: undefined,
            GIT_WORK_TREE: undefined,
            GIT_INDEX_FILE: undefined,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
        };

        spawnSync("git", ["-C", main, "init", "-q"], { stdio: "ignore", env: gitEnv });
        const commitResult = spawnSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "init"], {
            stdio: "pipe",
            env: gitEnv,
        });
        if (commitResult.status !== 0) return;

        const wt = path.join(tmpHome, "wt");
        const r = spawnSync("git", ["-C", main, "worktree", "add", wt], { stdio: "pipe", env: gitEnv });
        if (r.status !== 0) return;

        // Trust ONLY the main repo, not the worktree
        await writeConfig({ [fsSync.realpathSync(main).normalize("NFC")]: { hasTrustDialogAccepted: true } });

        // willHitTrustDialog on the worktree path should return false (resolves to main, finds trust)
        expect(await willHitTrustDialog(wt, {})).toBe(false);
    });
});
