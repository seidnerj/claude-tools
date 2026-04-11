import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const tmpDir = path.join(process.cwd(), ".test-tmp-title");

function writeSession(dir: string, sessionId: string, lines: object[]): string {
    const filepath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filepath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return filepath;
}

function readJsonlEntries(filepath: string): Array<Record<string, unknown>> {
    return fs
        .readFileSync(filepath, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
}

describe("slug rewriting logic", () => {
    beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("rewrites slug on all entries that have one", () => {
        const filepath = writeSession(tmpDir, "slug-rewrite", [
            { type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Hello" }, slug: "old-name-here" },
            { type: "assistant", timestamp: "2026-01-01T10:01:00Z", message: { content: "Hi" }, slug: "old-name-here" },
            { type: "custom-title", customTitle: "My Title", sessionId: "slug-rewrite" },
        ]);

        const content = fs.readFileSync(filepath, "utf-8");
        const lines = content.split("\n");
        const rewritten = lines.map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            try {
                const entry = JSON.parse(trimmed);
                if (typeof entry.slug === "string") {
                    entry.slug = "new-name-here";
                    return JSON.stringify(entry);
                }
                return line;
            } catch {
                return line;
            }
        });
        fs.writeFileSync(filepath, rewritten.join("\n"));

        const entries = readJsonlEntries(filepath);
        expect(entries[0].slug).toBe("new-name-here");
        expect(entries[1].slug).toBe("new-name-here");
        expect(entries[2].slug).toBeUndefined();
    });

    it("preserves entries without slug field", () => {
        const filepath = writeSession(tmpDir, "no-slug-entries", [
            { type: "permission-mode", permissionMode: "default" },
            { type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Hello" }, slug: "old-slug" },
            { type: "file-history-snapshot", messageId: "abc", snapshot: {} },
        ]);

        const content = fs.readFileSync(filepath, "utf-8");
        const lines = content.split("\n");
        const rewritten = lines.map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            try {
                const entry = JSON.parse(trimmed);
                if (typeof entry.slug === "string") {
                    entry.slug = "new-slug";
                    return JSON.stringify(entry);
                }
                return line;
            } catch {
                return line;
            }
        });
        fs.writeFileSync(filepath, rewritten.join("\n"));

        const entries = readJsonlEntries(filepath);
        expect(entries[0].type).toBe("permission-mode");
        expect(entries[0].slug).toBeUndefined();
        expect(entries[1].slug).toBe("new-slug");
        expect(entries[2].type).toBe("file-history-snapshot");
        expect(entries[2].slug).toBeUndefined();
    });

    it("handles empty session files", () => {
        const filepath = path.join(tmpDir, "empty.jsonl");
        fs.writeFileSync(filepath, "\n");

        const content = fs.readFileSync(filepath, "utf-8");
        const lines = content.split("\n");
        const rewritten = lines.map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            try {
                const entry = JSON.parse(trimmed);
                if (typeof entry.slug === "string") {
                    entry.slug = "new-slug";
                    return JSON.stringify(entry);
                }
                return line;
            } catch {
                return line;
            }
        });
        fs.writeFileSync(filepath, rewritten.join("\n"));

        const result = fs.readFileSync(filepath, "utf-8");
        expect(result).toBe("\n");
    });
});
