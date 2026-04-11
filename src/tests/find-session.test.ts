import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { searchProject, generateSessionNonce, extractMessageContent } from "../find-session.js";

const tmpDir = path.join(process.cwd(), ".test-tmp-find");

function writeSession(dir: string, sessionId: string, lines: object[]): string {
    const filepath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filepath, lines.map((l) => JSON.stringify(l)).join("\n"));
    return filepath;
}

describe("searchProject with SearchOptions", () => {
    beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("filters by date range (after)", () => {
        writeSession(tmpDir, "old-session", [{ type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "JotForm old" } }]);
        writeSession(tmpDir, "new-session", [{ type: "user", timestamp: "2026-03-09T10:00:00Z", message: { content: "JotForm new" } }]);

        const result = searchProject(tmpDir, "test", "JotForm", { after: "2026-03-01" });
        const ids = result.matches.map((m) => m.sessionId);
        expect(ids).toContain("new-session");
        expect(ids).not.toContain("old-session");
    });

    it("filters by date range (before)", () => {
        writeSession(tmpDir, "old-session", [{ type: "user", timestamp: "2026-01-01T10:00:00Z", message: { content: "JotForm old" } }]);
        writeSession(tmpDir, "new-session", [{ type: "user", timestamp: "2026-03-09T10:00:00Z", message: { content: "JotForm new" } }]);

        const result = searchProject(tmpDir, "test", "JotForm", { before: "2026-02-01" });
        const ids = result.matches.map((m) => m.sessionId);
        expect(ids).toContain("old-session");
        expect(ids).not.toContain("new-session");
    });

    it("excludes sessions by ID", () => {
        writeSession(tmpDir, "keep-session", [{ type: "user", timestamp: "2026-03-09T10:00:00Z", message: { content: "JotForm keep" } }]);
        writeSession(tmpDir, "skip-session", [{ type: "user", timestamp: "2026-03-09T10:00:00Z", message: { content: "JotForm skip" } }]);

        const result = searchProject(tmpDir, "test", "JotForm", { excludeSessions: ["skip-session"] });
        const ids = result.matches.map((m) => m.sessionId);
        expect(ids).toContain("keep-session");
        expect(ids).not.toContain("skip-session");
    });

    it("uses configurable context chars", () => {
        const longContent = "prefix ".repeat(20) + "JotForm" + " suffix".repeat(20);
        writeSession(tmpDir, "long-session", [{ type: "user", timestamp: "2026-03-09T10:00:00Z", message: { content: longContent } }]);

        const short = searchProject(tmpDir, "test", "JotForm", { contextChars: 50 });
        const long = searchProject(tmpDir, "test", "JotForm", { contextChars: 200 });

        expect(short.matches[0].snippets[0].length).toBeLessThanOrEqual(56);
        expect(long.matches[0].snippets[0].length).toBeGreaterThan(short.matches[0].snippets[0].length);
    });

    it("uses configurable max snippets", () => {
        const lines = Array.from({ length: 10 }, (_, i) => ({
            type: "user",
            timestamp: `2026-03-09T10:0${i}:00Z`,
            message: { content: `JotForm message number ${i} unique` },
        }));
        writeSession(tmpDir, "many-matches", lines);

        const result3 = searchProject(tmpDir, "test", "JotForm", { maxSnippets: 3 });
        const result7 = searchProject(tmpDir, "test", "JotForm", { maxSnippets: 7 });

        expect(result3.matches[0].snippets.length).toBeLessThanOrEqual(3);
        expect(result7.matches[0].snippets.length).toBeGreaterThan(3);
    });

    it("supports fuzzy matching via synonyms", () => {
        writeSession(tmpDir, "synonym-session", [
            { type: "user", timestamp: "2026-03-09T10:00:00Z", message: { content: "I opened a support case" } },
        ]);

        const exact = searchProject(tmpDir, "test", "ticket");
        expect(exact.matches).toHaveLength(0);

        const fuzzy = searchProject(tmpDir, "test", "ticket", { fuzzy: true });
        expect(fuzzy.matches).toHaveLength(1);
    });

    it("case-sensitive search works", () => {
        writeSession(tmpDir, "case-session", [{ type: "user", timestamp: "2026-03-09T10:00:00Z", message: { content: "JotForm submission" } }]);

        const insensitive = searchProject(tmpDir, "test", "jotform");
        expect(insensitive.matches).toHaveLength(1);

        const sensitive = searchProject(tmpDir, "test", "jotform", { caseSensitive: true });
        expect(sensitive.matches).toHaveLength(0);

        const sensitiveMatch = searchProject(tmpDir, "test", "JotForm", { caseSensitive: true });
        expect(sensitiveMatch.matches).toHaveLength(1);
    });
});

describe("generateSessionNonce", () => {
    it("generates unique nonces", () => {
        const a = generateSessionNonce();
        const b = generateSessionNonce();
        expect(a).not.toBe(b);
    });

    it("starts with the probe prefix", () => {
        const nonce = generateSessionNonce();
        expect(nonce).toMatch(/^__session_probe_.+__$/);
    });
});

describe("extractMessageContent", () => {
    it("extracts string content from user messages", () => {
        const entry = {
            type: "user",
            message: { role: "user", content: "Hello world" },
        };
        expect(extractMessageContent(entry)).toBe("Hello world");
    });

    it("extracts text blocks from assistant messages", () => {
        const entry = {
            type: "assistant",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "Here is the answer." }],
            },
        };
        expect(extractMessageContent(entry)).toBe("Here is the answer.");
    });

    it("extracts content from tool_result blocks (string content)", () => {
        const entry = {
            type: "user",
            message: {
                role: "user",
                content: [
                    {
                        tool_use_id: "toolu_123",
                        type: "tool_result",
                        content: "File contents here",
                    },
                ],
            },
        };
        expect(extractMessageContent(entry)).toContain("File contents here");
    });

    it("extracts content from tool_result blocks (nested array content)", () => {
        const entry = {
            type: "user",
            message: {
                role: "user",
                content: [
                    {
                        tool_use_id: "toolu_456",
                        type: "tool_result",
                        content: [{ type: "text", text: "Nested text" }],
                    },
                ],
            },
        };
        expect(extractMessageContent(entry)).toContain("Nested text");
    });

    it("extracts tool name and input from tool_use blocks", () => {
        const entry = {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_789",
                        name: "Read",
                        input: { file_path: "/tmp/test.ts" },
                    },
                ],
            },
        };
        const result = extractMessageContent(entry);
        expect(result).toContain("Read");
        expect(result).toContain("/tmp/test.ts");
    });

    it("combines text and tool_use blocks", () => {
        const entry = {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    { type: "text", text: "Let me read the file." },
                    {
                        type: "tool_use",
                        id: "toolu_abc",
                        name: "Read",
                        input: { file_path: "/tmp/foo.ts" },
                    },
                ],
            },
        };
        const result = extractMessageContent(entry);
        expect(result).toContain("Let me read the file.");
        expect(result).toContain("Read");
    });

    it("extracts thinking content", () => {
        const entry = {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "Let me analyze..." },
                    { type: "text", text: "Answer." },
                ],
            },
        };
        const result = extractMessageContent(entry);
        expect(result).toContain("Let me analyze...");
        expect(result).toContain("Answer.");
    });

    it("returns empty for permission-mode entries", () => {
        expect(extractMessageContent({ type: "permission-mode" })).toBe("");
    });

    it("returns empty for file-history-snapshot entries", () => {
        expect(extractMessageContent({ type: "file-history-snapshot", snapshot: {} })).toBe("");
    });

    it("extracts summary entries", () => {
        expect(extractMessageContent({ type: "summary", summary: "Session summary text" })).toBe("Session summary text");
    });

    it("extracts custom-title entries", () => {
        expect(extractMessageContent({ type: "custom-title", customTitle: "My Title" })).toBe("My Title");
    });

    it("truncates long tool_use input values", () => {
        const entry = {
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_long",
                        name: "Write",
                        input: { content: "x".repeat(300) },
                    },
                ],
            },
        };
        const result = extractMessageContent(entry);
        expect(result.length).toBeLessThan(300);
        expect(result).toContain("...");
    });
});
