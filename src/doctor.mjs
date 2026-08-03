#!/usr/bin/env bun

import { hasRequiredFailures, renderDoctorHuman, runDoctor } from './doctor/index.mjs';

export async function main(args = process.argv.slice(2), output = console) {
    const report = await runDoctor();
    if (args.includes('--json')) output.log(JSON.stringify(report, null, 2));
    else output.log(renderDoctorHuman(report));
    return hasRequiredFailures(report.results) ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
