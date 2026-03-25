#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// CLI: Check Claude status page
// ---------------------------------------------------------------------------

import { getClaudeStatus } from "../claude-status.js";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    let maxIncidents: number | undefined;
    let statusFilter: string | undefined;
    let daysBack: number | undefined;

    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "--max" || args[i] === "-n") && args[i + 1]) {
            maxIncidents = Number(args[++i]);
        } else if ((args[i] === "--status" || args[i] === "-s") && args[i + 1]) {
            statusFilter = args[++i];
        } else if ((args[i] === "--days" || args[i] === "-d") && args[i + 1]) {
            daysBack = Number(args[++i]);
        } else if (args[i] === "--help" || args[i] === "-h") {
            console.log("Usage: claude-status [options]");
            console.log("");
            console.log("Options:");
            console.log("  -n, --max <count>     Maximum incidents to show");
            console.log("  -s, --status <status>  Filter by status (e.g. resolved, investigating)");
            console.log("  -d, --days <days>      Only show incidents from last N days");
            console.log("  -h, --help             Show this help");
            process.exit(0);
        }
    }

    const result = await getClaudeStatus({ maxIncidents, statusFilter, daysBack });

    if (result.summary) {
        console.log(`Status: ${result.summary.description}`);
        console.log(`Indicator: ${result.summary.indicator}`);
        console.log(`Updated: ${result.summary.updatedAt}`);
        console.log("");
        console.log("Components:");
        for (const c of result.summary.components) {
            console.log(`  ${c.name}: ${c.status}`);
        }
        if (result.summary.activeIncidents.length > 0) {
            console.log("");
            console.log("Active incidents:");
            for (const name of result.summary.activeIncidents) {
                console.log(`  - ${name}`);
            }
        }
        if (result.summary.scheduledMaintenances.length > 0) {
            console.log("");
            console.log("Scheduled maintenance:");
            for (const name of result.summary.scheduledMaintenances) {
                console.log(`  - ${name}`);
            }
        }
    } else {
        console.log(result.operational ? "Status: OPERATIONAL" : "Status: DEGRADED - active incidents detected");
    }

    console.log("");
    console.log(`Incident history (${result.incidentCount}):`);
    console.log("");

    for (const inc of result.incidents) {
        console.log(`--- ${inc.title} ---`);
        console.log(`  Status: ${inc.currentStatus}`);
        console.log(`  Date:   ${inc.pubDate}`);
        console.log(`  Link:   ${inc.link}`);
        for (const u of inc.updates) {
            console.log(`  [${u.timestamp}] ${u.status} - ${u.message}`);
        }
        console.log("");
    }
}

main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
});
