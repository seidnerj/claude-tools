import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    readClaudeConfig,
    writeClaudeConfig,
    backupClaudeConfig,
    restoreMcpBackup,
    listMcpServers,
    getMcpServer,
    addMcpServer,
    updateMcpServer,
    removeMcpServer,
} from "../mcp-servers.js";

const tmpDir = path.join(process.cwd(), ".test-tmp-mcp");
const configPath = path.join(tmpDir, "claude.json");

function writeConfig(data: Record<string, unknown>): void {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
}

const SAMPLE_CONFIG = {
    mcpServers: {
        "test-server": {
            type: "stdio" as const,
            command: "node",
            args: ["server.js"],
            env: { FOO: "bar" },
        },
        "remote-server": {
            type: "http" as const,
            url: "https://example.com/mcp",
        },
    },
    projects: {
        "/Users/test/my-project": {
            mcpServers: {
                "project-server": {
                    type: "stdio" as const,
                    command: "npx",
                    args: ["-y", "my-mcp"],
                },
            },
        },
    },
};

describe("readClaudeConfig / writeClaudeConfig", () => {
    beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("reads and parses a config file", () => {
        writeConfig({ mcpServers: {} });
        const config = readClaudeConfig(configPath);
        expect(config.mcpServers).toEqual({});
    });

    it("throws if config file does not exist", () => {
        expect(() => readClaudeConfig(path.join(tmpDir, "nonexistent.json"))).toThrow("not found");
    });

    it("writes config back with formatting", () => {
        writeClaudeConfig({ mcpServers: { test: { command: "echo" } } }, configPath);
        const raw = fs.readFileSync(configPath, "utf-8");
        expect(raw).toContain('"mcpServers"');
        expect(raw).toContain("  ");
        expect(raw.endsWith("\n")).toBe(true);
    });
});

describe("backupClaudeConfig / restoreMcpBackup", () => {
    beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("creates a timestamped backup file", () => {
        writeConfig({ mcpServers: { original: { command: "test" } } });
        const backupPath = backupClaudeConfig(configPath);
        expect(fs.existsSync(backupPath)).toBe(true);
        expect(backupPath).toContain(".backup.");
        const backup = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
        expect(backup.mcpServers.original).toBeDefined();
    });

    it("restores from a backup", () => {
        writeConfig({ mcpServers: { original: { command: "test" } } });
        const backupPath = backupClaudeConfig(configPath);

        writeConfig({ mcpServers: { modified: { command: "changed" } } });
        expect(readClaudeConfig(configPath).mcpServers).toHaveProperty("modified");

        restoreMcpBackup(backupPath, configPath);
        const restored = readClaudeConfig(configPath);
        expect(restored.mcpServers).toHaveProperty("original");
        expect(restored.mcpServers).not.toHaveProperty("modified");
    });

    it("throws if backup file does not exist", () => {
        expect(() => restoreMcpBackup("/nonexistent/backup.json", configPath)).toThrow("not found");
    });
});

describe("listMcpServers", () => {
    beforeEach(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
        writeConfig(SAMPLE_CONFIG);
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("lists all servers (global + project)", () => {
        const servers = listMcpServers(undefined, configPath);
        const names = servers.map((s) => s.name);
        expect(names).toContain("test-server");
        expect(names).toContain("remote-server");
        expect(names).toContain("project-server");
    });

    it("lists only project-scoped servers when projectPath given", () => {
        const servers = listMcpServers("/Users/test/my-project", configPath);
        expect(servers).toHaveLength(1);
        expect(servers[0].name).toBe("project-server");
        expect(servers[0].scope).toBe("project");
    });

    it("returns empty for unknown project", () => {
        const servers = listMcpServers("/unknown/project", configPath);
        expect(servers).toHaveLength(0);
    });

    it("includes scope information", () => {
        const servers = listMcpServers(undefined, configPath);
        const global = servers.filter((s) => s.scope === "global");
        const project = servers.filter((s) => s.scope === "project");
        expect(global).toHaveLength(2);
        expect(project).toHaveLength(1);
    });
});

describe("getMcpServer", () => {
    beforeEach(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
        writeConfig(SAMPLE_CONFIG);
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("gets a global server by name", () => {
        const server = getMcpServer("test-server", undefined, configPath);
        expect(server).not.toBeNull();
        expect(server!.config.command).toBe("node");
        expect(server!.scope).toBe("global");
    });

    it("gets a project-scoped server", () => {
        const server = getMcpServer("project-server", "/Users/test/my-project", configPath);
        expect(server).not.toBeNull();
        expect(server!.config.command).toBe("npx");
        expect(server!.scope).toBe("project");
    });

    it("falls back to global when not found in project", () => {
        const server = getMcpServer("test-server", "/Users/test/my-project", configPath);
        expect(server).not.toBeNull();
        expect(server!.scope).toBe("global");
    });

    it("returns null for unknown server", () => {
        expect(getMcpServer("nonexistent", undefined, configPath)).toBeNull();
    });
});

describe("addMcpServer", () => {
    beforeEach(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
        writeConfig(SAMPLE_CONFIG);
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("adds a global server", () => {
        const result = addMcpServer("new-server", { command: "new-cmd", args: ["--flag"] }, undefined, configPath);
        expect(result.success).toBe(true);
        expect(result.backupPath).toBeDefined();
        const server = getMcpServer("new-server", undefined, configPath);
        expect(server!.config.command).toBe("new-cmd");
    });

    it("adds a project-scoped server", () => {
        const result = addMcpServer("new-proj-server", { command: "proj-cmd" }, "/Users/test/my-project", configPath);
        expect(result.success).toBe(true);
        expect(result.server!.scope).toBe("project");
        const server = getMcpServer("new-proj-server", "/Users/test/my-project", configPath);
        expect(server!.config.command).toBe("proj-cmd");
    });

    it("throws if server already exists globally", () => {
        expect(() => addMcpServer("test-server", { command: "dup" }, undefined, configPath)).toThrow("already exists");
    });

    it("throws if server already exists in project", () => {
        expect(() => addMcpServer("project-server", { command: "dup" }, "/Users/test/my-project", configPath)).toThrow("already exists");
    });

    it("creates backup before adding", () => {
        const result = addMcpServer("backup-test", { command: "cmd" }, undefined, configPath);
        expect(fs.existsSync(result.backupPath!)).toBe(true);
    });

    it("creates project entry if it does not exist", () => {
        const result = addMcpServer("brand-new", { command: "cmd" }, "/new/project", configPath);
        expect(result.success).toBe(true);
        const server = getMcpServer("brand-new", "/new/project", configPath);
        expect(server).not.toBeNull();
    });
});

describe("updateMcpServer", () => {
    beforeEach(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
        writeConfig(SAMPLE_CONFIG);
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("updates a global server (merge)", () => {
        const result = updateMcpServer("test-server", { args: ["new-arg"] }, undefined, configPath);
        expect(result.success).toBe(true);
        const server = getMcpServer("test-server", undefined, configPath);
        expect(server!.config.args).toEqual(["new-arg"]);
        expect(server!.config.command).toBe("node");
    });

    it("updates a project-scoped server", () => {
        const result = updateMcpServer("project-server", { env: { KEY: "val" } }, "/Users/test/my-project", configPath);
        expect(result.success).toBe(true);
        const server = getMcpServer("project-server", "/Users/test/my-project", configPath);
        expect(server!.config.env).toEqual({ KEY: "val" });
        expect(server!.config.command).toBe("npx");
    });

    it("throws if server does not exist", () => {
        expect(() => updateMcpServer("nonexistent", { command: "x" }, undefined, configPath)).toThrow("not found");
    });

    it("creates backup before updating", () => {
        const result = updateMcpServer("test-server", { args: [] }, undefined, configPath);
        expect(fs.existsSync(result.backupPath!)).toBe(true);
    });

    it("renames a global server", () => {
        const result = updateMcpServer("test-server", {}, undefined, configPath, "renamed-server");
        expect(result.success).toBe(true);
        expect(result.server!.name).toBe("renamed-server");
        expect(getMcpServer("renamed-server", undefined, configPath)).not.toBeNull();
        expect(getMcpServer("test-server", undefined, configPath)).toBeNull();
    });

    it("renames and updates a global server simultaneously", () => {
        const result = updateMcpServer("test-server", { args: ["new-arg"] }, undefined, configPath, "renamed-server");
        expect(result.success).toBe(true);
        const server = getMcpServer("renamed-server", undefined, configPath);
        expect(server!.config.args).toEqual(["new-arg"]);
        expect(server!.config.command).toBe("node");
        expect(getMcpServer("test-server", undefined, configPath)).toBeNull();
    });

    it("renames a project-scoped server", () => {
        const result = updateMcpServer("project-server", {}, "/Users/test/my-project", configPath, "renamed-project-server");
        expect(result.success).toBe(true);
        expect(getMcpServer("renamed-project-server", "/Users/test/my-project", configPath)).not.toBeNull();
        expect(getMcpServer("project-server", "/Users/test/my-project", configPath)).toBeNull();
    });

    it("throws if new name conflicts with existing global server", () => {
        expect(() => updateMcpServer("test-server", {}, undefined, configPath, "remote-server")).toThrow(
            'MCP server "remote-server" already exists globally'
        );
    });

    it("throws if new name conflicts with existing project server", () => {
        writeConfig({
            ...SAMPLE_CONFIG,
            projects: {
                "/Users/test/my-project": {
                    mcpServers: {
                        "project-server": { type: "stdio" as const, command: "npx", args: ["-y", "my-mcp"] },
                        "other-server": { type: "stdio" as const, command: "node", args: [] },
                    },
                },
            },
        });
        expect(() => updateMcpServer("project-server", {}, "/Users/test/my-project", configPath, "other-server")).toThrow(
            'MCP server "other-server" already exists in project'
        );
    });

    it("no-ops when new name equals current name", () => {
        const result = updateMcpServer("test-server", { args: ["updated"] }, undefined, configPath, "test-server");
        expect(result.success).toBe(true);
        expect(result.server!.name).toBe("test-server");
        expect(getMcpServer("test-server", undefined, configPath)!.config.args).toEqual(["updated"]);
    });
});

describe("removeMcpServer", () => {
    beforeEach(() => {
        fs.mkdirSync(tmpDir, { recursive: true });
        writeConfig(SAMPLE_CONFIG);
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it("removes a global server", () => {
        const result = removeMcpServer("test-server", undefined, configPath);
        expect(result.success).toBe(true);
        expect(result.server!.config.command).toBe("node");
        expect(getMcpServer("test-server", undefined, configPath)).toBeNull();
    });

    it("removes a project-scoped server", () => {
        const result = removeMcpServer("project-server", "/Users/test/my-project", configPath);
        expect(result.success).toBe(true);
        expect(getMcpServer("project-server", "/Users/test/my-project", configPath)).toBeNull();
    });

    it("throws if server does not exist", () => {
        expect(() => removeMcpServer("nonexistent", undefined, configPath)).toThrow("not found");
    });

    it("creates backup before removing", () => {
        const result = removeMcpServer("remote-server", undefined, configPath);
        expect(fs.existsSync(result.backupPath!)).toBe(true);
    });

    it("does not affect other servers", () => {
        removeMcpServer("test-server", undefined, configPath);
        expect(getMcpServer("remote-server", undefined, configPath)).not.toBeNull();
    });
});
