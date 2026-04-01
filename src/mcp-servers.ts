// ---------------------------------------------------------------------------
// MCP server configuration management for ~/.claude.json
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { McpServerConfig, McpServerEntry, McpServerResult } from "./types.js";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".claude.json");

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

export function readClaudeConfig(configPath = DEFAULT_CONFIG_PATH): Record<string, unknown> {
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content) as Record<string, unknown>;
}

export function writeClaudeConfig(data: Record<string, unknown>, configPath = DEFAULT_CONFIG_PATH): void {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

export function backupClaudeConfig(configPath = DEFAULT_CONFIG_PATH): string {
    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${configPath}.backup.${timestamp}`;
    fs.copyFileSync(configPath, backupPath);
    return backupPath;
}

export function restoreMcpBackup(backupPath: string, configPath = DEFAULT_CONFIG_PATH): { success: boolean } {
    if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`);
    }
    JSON.parse(fs.readFileSync(backupPath, "utf-8"));
    fs.copyFileSync(backupPath, configPath);
    return { success: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getGlobalServers(config: Record<string, unknown>): Record<string, McpServerConfig> {
    return (config.mcpServers as Record<string, McpServerConfig>) ?? {};
}

function getProjectServers(
    config: Record<string, unknown>,
    projectPath: string
): { servers: Record<string, McpServerConfig>; projectKey: string } | null {
    const projects = config.projects as Record<string, Record<string, unknown>> | undefined;
    if (!projects) return null;

    for (const [key, proj] of Object.entries(projects)) {
        if (key === projectPath || key.endsWith(projectPath) || projectPath.endsWith(key)) {
            return {
                servers: (proj.mcpServers as Record<string, McpServerConfig>) ?? {},
                projectKey: key,
            };
        }
    }

    return null;
}

function ensureProjectEntry(config: Record<string, unknown>, projectPath: string): { projectKey: string } {
    if (!config.projects) {
        config.projects = {};
    }
    const projects = config.projects as Record<string, Record<string, unknown>>;

    for (const key of Object.keys(projects)) {
        if (key === projectPath || key.endsWith(projectPath) || projectPath.endsWith(key)) {
            if (!projects[key].mcpServers) {
                projects[key].mcpServers = {};
            }
            return { projectKey: key };
        }
    }

    projects[projectPath] = { mcpServers: {} };
    return { projectKey: projectPath };
}

// ---------------------------------------------------------------------------
// List servers
// ---------------------------------------------------------------------------

export function listMcpServers(projectPath?: string, configPath = DEFAULT_CONFIG_PATH): McpServerEntry[] {
    const config = readClaudeConfig(configPath);
    const entries: McpServerEntry[] = [];

    if (projectPath) {
        const result = getProjectServers(config, projectPath);
        if (result) {
            for (const [name, cfg] of Object.entries(result.servers)) {
                entries.push({ name, config: cfg, scope: "project", projectPath: result.projectKey });
            }
        }
        return entries;
    }

    const globalServers = getGlobalServers(config);
    for (const [name, cfg] of Object.entries(globalServers)) {
        entries.push({ name, config: cfg, scope: "global" });
    }

    const projects = config.projects as Record<string, Record<string, unknown>> | undefined;
    if (projects) {
        for (const [projKey, proj] of Object.entries(projects)) {
            const servers = (proj.mcpServers as Record<string, McpServerConfig>) ?? {};
            for (const [name, cfg] of Object.entries(servers)) {
                entries.push({ name, config: cfg, scope: "project", projectPath: projKey });
            }
        }
    }

    return entries;
}

// ---------------------------------------------------------------------------
// Get server
// ---------------------------------------------------------------------------

export function getMcpServer(name: string, projectPath?: string, configPath = DEFAULT_CONFIG_PATH): McpServerEntry | null {
    const config = readClaudeConfig(configPath);

    if (projectPath) {
        const result = getProjectServers(config, projectPath);
        if (result && name in result.servers) {
            return { name, config: result.servers[name], scope: "project", projectPath: result.projectKey };
        }
    }

    const globalServers = getGlobalServers(config);
    if (name in globalServers) {
        return { name, config: globalServers[name], scope: "global" };
    }

    return null;
}

// ---------------------------------------------------------------------------
// Add server
// ---------------------------------------------------------------------------

export function addMcpServer(name: string, serverConfig: McpServerConfig, projectPath?: string, configPath = DEFAULT_CONFIG_PATH): McpServerResult {
    const config = readClaudeConfig(configPath);

    if (projectPath) {
        const result = getProjectServers(config, projectPath);
        if (result && name in result.servers) {
            throw new Error(`MCP server "${name}" already exists in project: ${result.projectKey}`);
        }
        const backupPath = backupClaudeConfig(configPath);
        const { projectKey } = ensureProjectEntry(config, projectPath);
        const projects = config.projects as Record<string, Record<string, unknown>>;
        (projects[projectKey].mcpServers as Record<string, McpServerConfig>)[name] = serverConfig;
        writeClaudeConfig(config, configPath);
        return { success: true, backupPath, server: { name, config: serverConfig, scope: "project", projectPath: projectKey } };
    }

    const globalServers = getGlobalServers(config);
    if (name in globalServers) {
        throw new Error(`MCP server "${name}" already exists globally`);
    }
    const backupPath = backupClaudeConfig(configPath);
    if (!config.mcpServers) {
        config.mcpServers = {};
    }
    (config.mcpServers as Record<string, McpServerConfig>)[name] = serverConfig;
    writeClaudeConfig(config, configPath);
    return { success: true, backupPath, server: { name, config: serverConfig, scope: "global" } };
}

// ---------------------------------------------------------------------------
// Update server
// ---------------------------------------------------------------------------

export function updateMcpServer(
    name: string,
    updates: Partial<McpServerConfig>,
    projectPath?: string,
    configPath = DEFAULT_CONFIG_PATH,
    newName?: string
): McpServerResult {
    const config = readClaudeConfig(configPath);
    const effectiveName = newName ?? name;

    if (projectPath) {
        const result = getProjectServers(config, projectPath);
        if (!result || !(name in result.servers)) {
            throw new Error(`MCP server "${name}" not found in project: ${projectPath}`);
        }
        if (newName && newName !== name && newName in result.servers) {
            throw new Error(`MCP server "${newName}" already exists in project: ${result.projectKey}`);
        }
        const backupPath = backupClaudeConfig(configPath);
        const merged = { ...result.servers[name], ...updates };
        const servers = (config.projects as Record<string, Record<string, unknown>>)[result.projectKey].mcpServers as Record<string, McpServerConfig>;
        if (newName && newName !== name) {
            delete servers[name];
        }
        servers[effectiveName] = merged;
        writeClaudeConfig(config, configPath);
        return { success: true, backupPath, server: { name: effectiveName, config: merged, scope: "project", projectPath: result.projectKey } };
    }

    const globalServers = getGlobalServers(config);
    if (!(name in globalServers)) {
        throw new Error(`MCP server "${name}" not found globally`);
    }
    if (newName && newName !== name && newName in globalServers) {
        throw new Error(`MCP server "${newName}" already exists globally`);
    }
    const backupPath = backupClaudeConfig(configPath);
    const merged = { ...globalServers[name], ...updates };
    const mcpServers = config.mcpServers as Record<string, McpServerConfig>;
    if (newName && newName !== name) {
        delete mcpServers[name];
    }
    mcpServers[effectiveName] = merged;
    writeClaudeConfig(config, configPath);
    return { success: true, backupPath, server: { name: effectiveName, config: merged, scope: "global" } };
}

// ---------------------------------------------------------------------------
// Remove server
// ---------------------------------------------------------------------------

export function removeMcpServer(name: string, projectPath?: string, configPath = DEFAULT_CONFIG_PATH): McpServerResult {
    const config = readClaudeConfig(configPath);

    if (projectPath) {
        const result = getProjectServers(config, projectPath);
        if (!result || !(name in result.servers)) {
            throw new Error(`MCP server "${name}" not found in project: ${projectPath}`);
        }
        const backupPath = backupClaudeConfig(configPath);
        const removed = result.servers[name];
        const projects = config.projects as Record<string, Record<string, unknown>>;
        delete (projects[result.projectKey].mcpServers as Record<string, McpServerConfig>)[name];
        writeClaudeConfig(config, configPath);
        return { success: true, backupPath, server: { name, config: removed, scope: "project", projectPath: result.projectKey } };
    }

    const globalServers = getGlobalServers(config);
    if (!(name in globalServers)) {
        throw new Error(`MCP server "${name}" not found globally`);
    }
    const backupPath = backupClaudeConfig(configPath);
    const removed = globalServers[name];
    delete (config.mcpServers as Record<string, McpServerConfig>)[name];
    writeClaudeConfig(config, configPath);
    return { success: true, backupPath, server: { name, config: removed, scope: "global" } };
}
