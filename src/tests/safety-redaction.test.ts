import { describe, it, expect } from "vitest";
import { isFastApprove, formatToolInput, TOOL_REDACTORS } from "../safety-redaction.js";

describe("isFastApprove", () => {
    it("fast-approves Read tool via redactor", () => {
        expect(isFastApprove("Read", { file_path: "/etc/passwd" })).toBeTruthy();
    });

    it("fast-approves Grep tool via redactor", () => {
        expect(isFastApprove("Grep", { pattern: "secret" })).toBeTruthy();
    });

    it("fast-approves cwd-local Edit", () => {
        expect(isFastApprove("Edit", { file_path: "/tmp/proj/foo.ts" }, "/tmp/proj")).toBeTruthy();
    });

    it("does not fast-approve Edit outside cwd", () => {
        expect(isFastApprove("Edit", { file_path: "/etc/passwd" }, "/tmp/proj")).toBeNull();
    });

    it("fast-approves git status", () => {
        expect(isFastApprove("Bash", { command: "git status" })).toBe("Known-safe read-only command");
    });

    it("does not fast-approve Bash with pipe", () => {
        expect(isFastApprove("Bash", { command: "ls | grep foo" })).toBeNull();
    });

    it("does not fast-approve unknown Bash command", () => {
        expect(isFastApprove("Bash", { command: "rm -rf /" })).toBeNull();
    });

    it("registry includes the standard read-only tools", () => {
        const expected = ["Glob", "LS", "NotebookRead", "Read", "Grep", "TodoWrite", "BashOutput"];
        for (const name of expected) {
            expect(TOOL_REDACTORS[name]).toBeTypeOf("function");
            expect(TOOL_REDACTORS[name]({})).toBeNull();
        }
    });
});

describe("formatToolInput", () => {
    it("Bash uses untrusted-command framing", () => {
        const out = formatToolInput("Bash", { command: "ls", description: "list files" });
        expect(out).toContain("<untrusted-command>");
        expect(out).toContain("ls");
        expect(out).toContain("list files");
    });

    it("Edit shows old/new strings", () => {
        const out = formatToolInput("Edit", { file_path: "/a", old_string: "x", new_string: "y" });
        expect(out).toContain("/a");
        expect(out).toContain("<old_string>");
        expect(out).toContain("<new_string>");
    });

    it("Write truncates large content", () => {
        const big = "x".repeat(10000);
        const out = formatToolInput("Write", { file_path: "/a", content: big });
        expect(out).toContain("(truncated)");
    });

    it("falls back to JSON for unknown tools", () => {
        const out = formatToolInput("WeirdTool", { foo: "bar" });
        expect(out).toContain('"foo"');
        expect(out).toContain('"bar"');
    });

    it("falls through to default formatter when redactor returns null", () => {
        const out = formatToolInput("Read", { file_path: "/etc/passwd", offset: 0 });
        expect(out).toContain("/etc/passwd");
    });
});
