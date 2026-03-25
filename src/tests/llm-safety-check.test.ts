import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock getApiKey and configGet before importing the module under test
vi.mock("../utils.js", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        getApiKey: vi.fn(() => null),
        configGet: vi.fn((key: string) => {
            if (key === "safety.billing_cch") return "64d93";
            if (key === "safety.billing_cc_version") return "2.1.83.c50";
            return null;
        }),
    };
});

// Mock fs/promises for resolveRequestedFiles tests
vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        stat: vi.fn(actual.stat as (...args: unknown[]) => unknown),
        readFile: vi.fn(actual.readFile as (...args: unknown[]) => unknown),
    };
});

import { stat, readFile } from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    checkCommandSafety,
    checkToolSafety,
    processHookInput,
    resolveRequestedFiles,
    isFastApprove,
    extractTaskContext,
    getBlockState,
    incrementBlockCount,
    resetConsecutiveBlocks,
    shouldDegradeToPrompt,
} from "../llm-safety-check.js";
import { getApiKey } from "../utils.js";

const mockStat = vi.mocked(stat);
const mockReadFile = vi.mocked(readFile);

const mockGetApiKey = vi.mocked(getApiKey);

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockGetApiKey.mockReturnValue(null);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helper to create a mock Claude API response
// ---------------------------------------------------------------------------

function mockApiResponse(decision: string, reason: string, files?: string[]) {
    const payload: Record<string, unknown> = { decision, reason };
    if (files) payload.files = files;
    return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
            content: [
                { type: "thinking", thinking: "..." },
                { type: "text", text: JSON.stringify(payload) },
            ],
        }),
    };
}

// ---------------------------------------------------------------------------
// resolveRequestedFiles
// ---------------------------------------------------------------------------

describe("resolveRequestedFiles", () => {
    it("reads files that exist", async () => {
        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 100 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("print('hello')" as never);

        const result = await resolveRequestedFiles(["/tmp/test_script.py"]);
        expect(result.get("/tmp/test_script.py")).toBe("print('hello')");
    });

    it("skips files that do not exist", async () => {
        mockStat.mockRejectedValueOnce(new Error("ENOENT"));

        const result = await resolveRequestedFiles(["/tmp/nonexistent.py"]);
        expect(result.size).toBe(0);
    });

    it("skips files larger than the size limit", async () => {
        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 100_000 } as Awaited<ReturnType<typeof stat>>);

        const result = await resolveRequestedFiles(["/tmp/huge_file.py"]);
        expect(result.size).toBe(0);
    });

    it("skips directories", async () => {
        mockStat.mockResolvedValueOnce({ isFile: () => false, size: 100 } as Awaited<ReturnType<typeof stat>>);

        const result = await resolveRequestedFiles(["/tmp/some_dir"]);
        expect(result.size).toBe(0);
    });

    it("reads multiple files", async () => {
        mockStat
            .mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>)
            .mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("script1" as never).mockResolvedValueOnce("script2" as never);

        const result = await resolveRequestedFiles(["/tmp/a.py", "/home/user/b.sh"]);
        expect(result.size).toBe(2);
        expect(result.get("/tmp/a.py")).toBe("script1");
        expect(result.get("/home/user/b.sh")).toBe("script2");
    });

    it("returns empty map for empty input", async () => {
        const result = await resolveRequestedFiles([]);
        expect(result.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// checkCommandSafety
// ---------------------------------------------------------------------------

describe("checkCommandSafety", () => {
    it("returns null when no API key is available", async () => {
        mockGetApiKey.mockReturnValue(null);

        const result = await checkCommandSafety("Bash", { command: "ls" });
        expect(result).toBeNull();
    });

    it("returns approve decision from API", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce(mockApiResponse("approve", "Safe read-only command"));

        const result = await checkCommandSafety("Bash", { command: "ls -la", description: "List files" });
        expect(result).toEqual({ decision: "approve", reason: "Safe read-only command" });

        // Verify the API was called with correct params
        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
        expect(opts.headers["x-api-key"]).toBe("test-key");

        const body = JSON.parse(opts.body);
        expect(body.model).toBe("claude-opus-4-6");
        expect(body.thinking).toEqual({ type: "adaptive" });
        const content = body.messages[0].content;
        expect(content).toContain("<untrusted-command>");
        expect(content).toContain("ls -la");
        expect(content).toContain("</untrusted-command>");
        expect(content).toContain("<untrusted-description>");
        expect(content).toContain("List files");
        expect(content).toContain("</untrusted-description>");
    });

    it("returns deny decision from API", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce(mockApiResponse("deny", "Dangerous command"));

        const result = await checkCommandSafety("Bash", { command: "rm -rf /" });
        expect(result).toEqual({ decision: "deny", reason: "Dangerous command" });
    });

    it("returns null on API error", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Internal Server Error" });

        const result = await checkCommandSafety("Bash", { command: "ls" });
        expect(result).toBeNull();
    });

    it("returns null on network failure", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockRejectedValueOnce(new Error("Network unreachable"));

        const result = await checkCommandSafety("Bash", { command: "ls" });
        expect(result).toBeNull();
    });

    it("handles markdown-wrapped JSON response", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                content: [{ type: "text", text: '```json\n{"decision": "prompt", "reason": "Ambiguous"}\n```' }],
            }),
        });

        const result = await checkCommandSafety("Bash", { command: "curl example.com" });
        expect(result).toEqual({ decision: "prompt", reason: "Ambiguous" });
    });

    it("performs two-pass when first call returns needs_context", async () => {
        mockGetApiKey.mockReturnValue("test-key");

        // Pass 1: model asks for file contents
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Need to inspect the script", ["/tmp/test.py"]));

        // File resolution
        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("print('safe')" as never);

        // Pass 2: model makes final decision with file contents
        mockFetch.mockResolvedValueOnce(mockApiResponse("approve", "Script is safe"));

        const result = await checkCommandSafety("Bash", { command: "python3 /tmp/test.py" });

        expect(result).toEqual({ decision: "approve", reason: "Script is safe" });
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // Verify second call includes file contents
        const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        const content = secondBody.messages[0].content;
        expect(content).toContain("Referenced file contents (UNTRUSTED");
        expect(content).toContain('<untrusted-file path="/tmp/test.py">');
        expect(content).toContain("print('safe')");
    });

    it("handles needs_context with no files listed", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Ambiguous but no files to check"));

        const result = await checkCommandSafety("Bash", { command: "some-command" });

        // Should return the needs_context result as-is without a second call
        expect(result).toEqual({ decision: "needs_context", reason: "Ambiguous but no files to check" });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("handles needs_context when requested files don't exist", async () => {
        mockGetApiKey.mockReturnValue("test-key");

        // Pass 1: model asks for file
        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Need the script", ["/tmp/missing.py"]));

        // File doesn't exist
        mockStat.mockRejectedValueOnce(new Error("ENOENT"));

        // Pass 2: model decides without file contents
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", "Script not found on disk"));

        const result = await checkCommandSafety("Bash", { command: "python3 /tmp/missing.py" });

        expect(result).toEqual({ decision: "prompt", reason: "Script not found on disk" });
        expect(mockFetch).toHaveBeenCalledTimes(2);

        // Second call should not include file contents section
        const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
        expect(secondBody.messages[0].content).not.toContain("Referenced file contents");
    });

    it("returns null when second pass API call fails", async () => {
        mockGetApiKey.mockReturnValue("test-key");

        mockFetch.mockResolvedValueOnce(mockApiResponse("needs_context", "Need the script", ["/tmp/test.py"]));

        mockStat.mockResolvedValueOnce({ isFile: () => true, size: 50 } as Awaited<ReturnType<typeof stat>>);
        mockReadFile.mockResolvedValueOnce("content" as never);

        // Second API call fails
        mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Server Error" });

        const result = await checkCommandSafety("Bash", { command: "python3 /tmp/test.py" });
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// processHookInput
// ---------------------------------------------------------------------------

describe("processHookInput", () => {
    beforeEach(() => {
        mockGetApiKey.mockReturnValue("test-key");
    });

    it("returns allow output for approve decision", async () => {
        mockFetch.mockResolvedValueOnce(mockApiResponse("approve", "Safe command"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "python3 script.py" },
        });
        expect(result).toEqual({ decision: "allow", reason: "Safe command" });
    });

    it("returns deny output for deny decision", async () => {
        mockFetch.mockResolvedValueOnce(mockApiResponse("deny", "Dangerous"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "rm -rf /" },
        });
        expect(result).toEqual({ decision: "deny", reason: "Dangerous" });
    });

    it("returns null for prompt decision (fall through)", async () => {
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", "Ambiguous"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "curl example.com" },
        });
        expect(result).toBeNull();
    });

    it("logs reason to stderr for prompt decision", async () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", "Contains hardcoded credentials"));

        await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "curl -u user:pass example.com" },
        });

        expect(stderrSpy).toHaveBeenCalledWith("LLM safety check [prompt]: Contains hardcoded credentials\n");
        stderrSpy.mockRestore();
    });

    it("does not log to stderr for prompt decision with empty reason", async () => {
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        mockFetch.mockResolvedValueOnce(mockApiResponse("prompt", ""));

        await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "curl example.com" },
        });

        expect(stderrSpy).not.toHaveBeenCalled();
        stderrSpy.mockRestore();
    });

    it("returns null on API failure (fall through)", async () => {
        mockFetch.mockRejectedValueOnce(new Error("timeout"));

        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "python3 script.py" },
        });
        expect(result).toBeNull();
    });

    it("fast-approves known-safe Bash commands without calling the API", async () => {
        mockGetApiKey.mockReturnValue("sk-ant-test");
        const result = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "git status" },
        });
        expect(result?.decision).toBe("allow");
        expect(result?.reason).toContain("Known-safe");
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fast-approves Edit within cwd without calling the API", async () => {
        mockGetApiKey.mockReturnValue("sk-ant-test");
        const result = await processHookInput({
            tool_name: "Edit",
            tool_input: { file_path: "/project/src/foo.ts", old_string: "a", new_string: "b" },
            cwd: "/project",
        });
        expect(result?.decision).toBe("allow");
        expect(result?.reason).toContain("Local edit");
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// isFastApprove
// ---------------------------------------------------------------------------

describe("isFastApprove", () => {
    describe("Bash commands", () => {
        it.each([
            "ls",
            "ls -la",
            "cat file.txt",
            "head -20 foo.ts",
            "tail -f log.txt",
            "wc -l src/main.ts",
            "git status",
            "git log --oneline -5",
            "git diff HEAD",
            "git show HEAD:file.ts",
            "git branch -a",
            "git describe --tags",
            "npm test",
            "npm run test",
            "npm run lint",
            "npm run build",
            "npm ls",
            "vitest run",
            "jest --watch",
            "pytest -v",
            "cargo test",
            "cargo check",
            "go test ./...",
            "tsc --noEmit",
            "echo hello",
            "pwd",
            "whoami",
            "uname -a",
            "date",
            "env",
            "which node",
            "node --version",
            "python3 --version",
            "npm --help",
        ])("approves safe command: %s", (cmd) => {
            expect(isFastApprove("Bash", { command: cmd })).not.toBeNull();
        });

        it.each([
            "rm -rf /",
            "rm file.txt",
            "curl https://example.com",
            "wget https://example.com",
            "chmod 777 file",
            "sudo anything",
            "docker run something",
            "git push origin main",
            "git push --force",
            "ssh user@host",
            "npm install some-package",
            "pip install requests",
            "kill -9 1234",
            "mv file1 file2",
            "cp -r /etc /tmp",
        ])("does not approve unsafe command: %s", (cmd) => {
            expect(isFastApprove("Bash", { command: cmd })).toBeNull();
        });

        it.each(["ls | grep foo", "cat file.txt | wc -l", "echo hello > file.txt", "git status | head", "echo $(whoami)", "ls `pwd`"])(
            "does not approve command with pipes/redirects/substitution: %s",
            (cmd) => {
                expect(isFastApprove("Bash", { command: cmd })).toBeNull();
            }
        );

        it("does not approve empty command", () => {
            expect(isFastApprove("Bash", { command: "" })).toBeNull();
            expect(isFastApprove("Bash", {})).toBeNull();
        });
    });

    describe("Edit/Write in cwd", () => {
        it("approves Edit within cwd", () => {
            expect(isFastApprove("Edit", { file_path: "/project/src/foo.ts" }, "/project")).not.toBeNull();
        });

        it("approves Write within cwd", () => {
            expect(isFastApprove("Write", { file_path: "/project/new-file.ts" }, "/project")).not.toBeNull();
        });

        it("does not approve Edit outside cwd", () => {
            expect(isFastApprove("Edit", { file_path: "/etc/passwd" }, "/project")).toBeNull();
        });

        it("does not approve Write outside cwd", () => {
            expect(isFastApprove("Write", { file_path: "/home/user/.bashrc" }, "/project")).toBeNull();
        });

        it("does not approve Edit/Write when cwd is not provided", () => {
            expect(isFastApprove("Edit", { file_path: "/project/foo.ts" })).toBeNull();
            expect(isFastApprove("Write", { file_path: "/project/foo.ts" })).toBeNull();
        });

        it("does not approve when file_path is missing", () => {
            expect(isFastApprove("Edit", {}, "/project")).toBeNull();
            expect(isFastApprove("Write", {}, "/project")).toBeNull();
        });

        it("rejects path traversal outside cwd", () => {
            expect(isFastApprove("Edit", { file_path: "/project/../etc/passwd" }, "/project")).toBeNull();
        });
    });

    describe("other tools", () => {
        it("returns null for tools not covered by fast-path", () => {
            expect(isFastApprove("WebFetch", { url: "https://example.com" })).toBeNull();
            expect(isFastApprove("Agent", { prompt: "do something" })).toBeNull();
            expect(isFastApprove("mcp__server__tool", { input: "data" })).toBeNull();
        });
    });
});

// ---------------------------------------------------------------------------
// checkToolSafety - multi-tool formatting
// ---------------------------------------------------------------------------

describe("checkToolSafety multi-tool formatting", () => {
    beforeEach(() => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValue(mockApiResponse("approve", "Safe"));
    });

    it("formats Edit tool input with file path and old/new strings", async () => {
        await checkToolSafety("Edit", {
            file_path: "/project/src/foo.ts",
            old_string: "old code",
            new_string: "new code",
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const content = body.messages[0].content;
        expect(content).toContain("Tool: Edit");
        expect(content).toContain("File: /project/src/foo.ts");
        expect(content).toContain("<old_string>");
        expect(content).toContain("old code");
        expect(content).toContain("<new_string>");
        expect(content).toContain("new code");
    });

    it("formats Write tool input with file path and content", async () => {
        await checkToolSafety("Write", {
            file_path: "/project/new-file.ts",
            content: "file content here",
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const content = body.messages[0].content;
        expect(content).toContain("Tool: Write");
        expect(content).toContain("File: /project/new-file.ts");
        expect(content).toContain("<content>");
        expect(content).toContain("file content here");
    });

    it("formats WebFetch tool input with URL", async () => {
        await checkToolSafety("WebFetch", {
            url: "https://example.com/api",
            prompt: "get the data",
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const content = body.messages[0].content;
        expect(content).toContain("Tool: WebFetch");
        expect(content).toContain("URL: https://example.com/api");
    });

    it("formats Agent tool input with prompt and subagent type", async () => {
        await checkToolSafety("Agent", {
            prompt: "search for files",
            subagent_type: "Explore",
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const content = body.messages[0].content;
        expect(content).toContain("Tool: Agent");
        expect(content).toContain("Subagent type: Explore");
        expect(content).toContain("search for files");
    });

    it("formats MCP tool input as JSON", async () => {
        await checkToolSafety("mcp__server__tool", {
            param1: "value1",
            param2: 42,
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const content = body.messages[0].content;
        expect(content).toContain("Tool: mcp__server__tool");
        expect(content).toContain('"param1"');
        expect(content).toContain('"value1"');
    });

    it("truncates large Write content", async () => {
        const largeContent = "x".repeat(10000);
        await checkToolSafety("Write", {
            file_path: "/project/big.ts",
            content: largeContent,
        });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        const content = body.messages[0].content;
        expect(content).toContain("... (truncated)");
        expect(content.length).toBeLessThan(largeContent.length);
    });
});

// ---------------------------------------------------------------------------
// extractTaskContext
// ---------------------------------------------------------------------------

describe("extractTaskContext", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "safety-ctx-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeTranscript(lines: object[]): string {
        const filePath = path.join(tmpDir, "transcript.jsonl");
        fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
        return filePath;
    }

    it("returns empty string for 'none' context level", () => {
        const p = writeTranscript([{ type: "user", message: { content: "hello" } }]);
        expect(extractTaskContext(p, "none")).toBe("");
    });

    it("returns empty string for missing transcript", () => {
        expect(extractTaskContext("/nonexistent/file.jsonl", "user-only")).toBe("");
    });

    it("returns empty string for empty transcript", () => {
        const p = writeTranscript([]);
        expect(extractTaskContext(p, "user-only")).toBe("");
    });

    it("extracts user messages in user-only mode", () => {
        const p = writeTranscript([
            { type: "user", message: { content: "Fix the auth bug" } },
            { type: "assistant", message: { content: "I will look at the code" } },
            { type: "user", message: { content: "Also check the tests" } },
        ]);
        const ctx = extractTaskContext(p, "user-only");
        expect(ctx).toContain("Fix the auth bug");
        expect(ctx).toContain("Also check the tests");
        expect(ctx).not.toContain("I will look at the code");
        expect(ctx).toContain('<task-context level="user-only">');
    });

    it("includes assistant messages in full mode", () => {
        const p = writeTranscript([
            { type: "user", message: { content: "Fix the auth bug" } },
            { type: "assistant", message: { content: "I will look at the code" } },
        ]);
        const ctx = extractTaskContext(p, "full");
        expect(ctx).toContain("Fix the auth bug");
        expect(ctx).toContain("I will look at the code");
        expect(ctx).toContain("<untrusted-assistant>");
        expect(ctx).toContain('<task-context level="full">');
    });

    it("handles array content blocks", () => {
        const p = writeTranscript([{ type: "user", message: { content: [{ type: "text", text: "array content" }] } }]);
        const ctx = extractTaskContext(p, "user-only");
        expect(ctx).toContain("array content");
    });

    it("includes first user message even if not in recent window", () => {
        const msgs = [
            { type: "user", message: { content: "Initial task" } },
            ...Array.from({ length: 10 }, (_, i) => ({ type: "user", message: { content: `msg ${i}` } })),
        ];
        const p = writeTranscript(msgs);
        const ctx = extractTaskContext(p, "user-only");
        expect(ctx).toContain("[Initial request]");
        expect(ctx).toContain("Initial task");
    });

    it("does not duplicate first message if it is in the recent window", () => {
        const p = writeTranscript([{ type: "user", message: { content: "Only message" } }]);
        const ctx = extractTaskContext(p, "user-only");
        expect(ctx).not.toContain("[Initial request]");
        expect(ctx).toContain("Only message");
    });

    it("skips malformed JSON lines gracefully", () => {
        const filePath = path.join(tmpDir, "bad.jsonl");
        fs.writeFileSync(filePath, 'not json\n{"type":"user","message":{"content":"valid"}}\n');
        const ctx = extractTaskContext(filePath, "user-only");
        expect(ctx).toContain("valid");
    });

    it("returns empty string for empty transcript path", () => {
        expect(extractTaskContext("", "user-only")).toBe("");
    });
});

// ---------------------------------------------------------------------------
// Block count tracking
// ---------------------------------------------------------------------------

describe("block count tracking", () => {
    const testSessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const blockDir = path.join(os.tmpdir(), "claude-safety-hook");

    afterEach(() => {
        try {
            fs.unlinkSync(path.join(blockDir, `${testSessionId}.json`));
        } catch {
            // may not exist
        }
    });

    it("returns zero state for unknown session", () => {
        const state = getBlockState(testSessionId);
        expect(state.consecutiveDenials).toBe(0);
        expect(state.totalDenials).toBe(0);
    });

    it("increments both counters", () => {
        const s1 = incrementBlockCount(testSessionId);
        expect(s1.consecutiveDenials).toBe(1);
        expect(s1.totalDenials).toBe(1);

        const s2 = incrementBlockCount(testSessionId);
        expect(s2.consecutiveDenials).toBe(2);
        expect(s2.totalDenials).toBe(2);
    });

    it("resets consecutive but not total on approve", () => {
        incrementBlockCount(testSessionId);
        incrementBlockCount(testSessionId);
        resetConsecutiveBlocks(testSessionId);

        const state = getBlockState(testSessionId);
        expect(state.consecutiveDenials).toBe(0);
        expect(state.totalDenials).toBe(2);
    });

    it("degrades after 3 consecutive denials", () => {
        expect(shouldDegradeToPrompt({ consecutiveDenials: 2, totalDenials: 2 })).toBe(false);
        expect(shouldDegradeToPrompt({ consecutiveDenials: 3, totalDenials: 3 })).toBe(true);
    });

    it("degrades after 20 total denials", () => {
        expect(shouldDegradeToPrompt({ consecutiveDenials: 0, totalDenials: 19 })).toBe(false);
        expect(shouldDegradeToPrompt({ consecutiveDenials: 0, totalDenials: 20 })).toBe(true);
    });

    it("processHookInput degrades deny to prompt after threshold", async () => {
        mockGetApiKey.mockReturnValue("test-key");
        mockFetch.mockResolvedValue(mockApiResponse("deny", "Dangerous"));

        const sessionId = `degrade-test-${Date.now()}`;

        // First 3 denials should be hard deny
        for (let i = 0; i < 3; i++) {
            const result = await processHookInput({
                tool_name: "Bash",
                tool_input: { command: "rm -rf /" },
                session_id: sessionId,
            });
            if (i < 2) {
                expect(result?.decision).toBe("deny");
            }
        }

        // After 3 consecutive, should degrade to null (prompt/fall-through)
        const degraded = await processHookInput({
            tool_name: "Bash",
            tool_input: { command: "rm -rf /" },
            session_id: sessionId,
        });
        expect(degraded).toBeNull();

        // Cleanup
        try {
            fs.unlinkSync(path.join(blockDir, `${sessionId}.json`));
        } catch {
            // ignore
        }
    });
});
