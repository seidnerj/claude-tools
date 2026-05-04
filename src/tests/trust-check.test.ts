import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { willHitTrustDialog, WorkspaceNotTrustedError } from "../trust-check.js";

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
        const nfd = "café";
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
