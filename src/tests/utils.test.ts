import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pathToDirname, dirnameToPath, extractStrings, parseSession, sessionDescription, listSessions } from "../utils.js";

// ---------------------------------------------------------------------------
// pathToDirname / dirnameToPath
// ---------------------------------------------------------------------------

describe("pathToDirname", () => {
    it("converts absolute path to dash-delimited name", () => {
        expect(pathToDirname("/Users/test/project")).toBe("-Users-test-project");
    });

    it("replaces dots with dashes", () => {
        expect(pathToDirname("/Users/test/.hidden")).toBe("-Users-test--hidden");
    });
});

describe("dirnameToPath", () => {
    it("converts simple dash-delimited name back when dirs don't exist", () => {
        // Without real filesystem entries, falls back to simple replacement
        const result = dirnameToPath("-Users-test-project");
        expect(result).toBe("/Users/test/project");
    });

    it("handles dot-prefixed components (-- sequences)", () => {
        const result = dirnameToPath("-Users-test--hidden");
        // Should decode -- as dot prefix
        expect(result).toContain(".hidden");
    });

    it("returns / for empty parts", () => {
        expect(dirnameToPath("-")).toBe("/");
    });
});

// ---------------------------------------------------------------------------
// extractStrings
// ---------------------------------------------------------------------------

describe("extractStrings", () => {
    it("extracts string from primitive", () => {
        expect(extractStrings("hello")).toEqual(["hello"]);
    });

    it("extracts strings from nested object", () => {
        const result = extractStrings({ a: "one", b: { c: "two" }, d: [3, "three"] });
        expect(result).toContain("one");
        expect(result).toContain("two");
        expect(result).toContain("three");
    });

    it("handles null/undefined gracefully", () => {
        expect(extractStrings(null)).toEqual([]);
        expect(extractStrings(undefined)).toEqual([]);
    });

    it("respects depth limit", () => {
        // Create deeply nested structure
        let obj: unknown = "deep";
        for (let i = 0; i < 15; i++) {
            obj = { nested: obj };
        }
        const result = extractStrings(obj);
        expect(result).toEqual([]); // Should hit depth limit
    });
});

// ---------------------------------------------------------------------------
// parseSession / sessionDescription
// ---------------------------------------------------------------------------

describe("parseSession", () => {
    const tmpDir = path.join(process.cwd(), ".test-tmp");

    beforeEach(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("parses a session with messages and title", () => {
        const lines = [
            JSON.stringify({ type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Fix the bug" } }),
            JSON.stringify({ type: "assistant", timestamp: "2026-01-01T10:01:00Z", message: { content: "Done" } }),
            JSON.stringify({ type: "custom-title", sessionId: "abc123", customTitle: "Fix login bug" }),
        ];
        const filepath = path.join(tmpDir, "abc123.jsonl");
        fs.writeFileSync(filepath, lines.join("\n"));

        const s = parseSession(filepath);
        expect(s.sessionId).toBe("abc123");
        expect(s.msgCount).toBe(2);
        expect(s.customTitle).toBe("Fix login bug");
        expect(s.firstPrompt).toBe("Fix the bug");
        expect(s.created).toBe("2026-01-01T10:00:00Z");
        expect(s.modified).toBe("2026-01-01T10:01:00Z");
    });

    it("parses a session with AI title", () => {
        const lines = [
            JSON.stringify({ type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Hello" } }),
            JSON.stringify({ type: "ai-title", aiTitle: "Greet the user" }),
        ];
        const filepath = path.join(tmpDir, "def456.jsonl");
        fs.writeFileSync(filepath, lines.join("\n"));

        const s = parseSession(filepath);
        expect(s.aiTitle).toBe("Greet the user");
    });

    it("ignores broken summary lines", () => {
        const lines = [
            JSON.stringify({ type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Test" } }),
            JSON.stringify({ type: "summary", summary: "I don't have enough context" }),
            JSON.stringify({ type: "summary", summary: "Good summary here" }),
        ];
        const filepath = path.join(tmpDir, "ghi789.jsonl");
        fs.writeFileSync(filepath, lines.join("\n"));

        const s = parseSession(filepath);
        expect(s.summary).toBe("Good summary here");
    });

    it("skips Warmup messages for firstPrompt", () => {
        const lines = [
            JSON.stringify({ type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Warmup" } }),
            JSON.stringify({ type: "user", timestamp: "2026-01-01T10:01:00Z", message: { content: "Real prompt" } }),
        ];
        const filepath = path.join(tmpDir, "jkl012.jsonl");
        fs.writeFileSync(filepath, lines.join("\n"));

        const s = parseSession(filepath);
        expect(s.firstPrompt).toBe("Real prompt");
    });

    it("extracts slug from session entries", () => {
        const lines = [
            JSON.stringify({
                type: "user",
                timestamp: "2026-01-01T10:00:00Z",
                message: { content: "Hello" },
                slug: "calm-painting-feather",
            }),
            JSON.stringify({
                type: "assistant",
                timestamp: "2026-01-01T10:01:00Z",
                message: { content: "Hi" },
                slug: "calm-painting-feather",
            }),
        ];
        const filepath = path.join(tmpDir, "slug-session.jsonl");
        fs.writeFileSync(filepath, lines.join("\n"));

        const s = parseSession(filepath);
        expect(s.slug).toBe("calm-painting-feather");
    });

    it("returns empty slug when no entries have slug field", () => {
        const lines = [JSON.stringify({ type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Hello" } })];
        const filepath = path.join(tmpDir, "no-slug.jsonl");
        fs.writeFileSync(filepath, lines.join("\n"));

        const s = parseSession(filepath);
        expect(s.slug).toBe("");
    });
});

describe("sessionDescription", () => {
    it("prefers custom title", () => {
        expect(
            sessionDescription({
                sessionId: "x",
                msgCount: 1,
                slug: "",
                customTitle: "Custom",
                aiTitle: "AI",
                summary: "Sum",
                firstPrompt: "Prompt",
                created: "",
                modified: "",
            })
        ).toBe("Custom");
    });

    it("falls back to AI title", () => {
        expect(
            sessionDescription({
                sessionId: "x",
                msgCount: 1,
                slug: "",
                customTitle: "",
                aiTitle: "AI",
                summary: "Sum",
                firstPrompt: "Prompt",
                created: "",
                modified: "",
            })
        ).toBe("AI");
    });

    it("falls back to summary", () => {
        expect(
            sessionDescription({
                sessionId: "x",
                msgCount: 1,
                slug: "",
                customTitle: "",
                aiTitle: "",
                summary: "Sum",
                firstPrompt: "Prompt",
                created: "",
                modified: "",
            })
        ).toBe("Sum");
    });

    it("falls back to truncated first prompt", () => {
        const longPrompt = "a".repeat(100);
        expect(
            sessionDescription({
                sessionId: "x",
                msgCount: 1,
                slug: "",
                customTitle: "",
                aiTitle: "",
                summary: "",
                firstPrompt: longPrompt,
                created: "",
                modified: "",
            })
        ).toBe("a".repeat(60));
    });
});

describe("listSessions", () => {
    const tmpDir = path.join(process.cwd(), ".test-tmp-list");

    beforeEach(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("lists sessions with messages, skips empty ones", () => {
        // Session with messages
        fs.writeFileSync(
            path.join(tmpDir, "sess1.jsonl"),
            JSON.stringify({ type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "Hello" } })
        );
        // Empty session
        fs.writeFileSync(path.join(tmpDir, "sess2.jsonl"), "");
        // Non-jsonl file
        fs.writeFileSync(path.join(tmpDir, "readme.txt"), "ignore me");

        const sessions = listSessions(tmpDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].sessionId).toBe("sess1");
    });
});
