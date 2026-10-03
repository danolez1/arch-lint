#!/usr/bin/env node
import { runCli } from "./cli.mjs";

await runCli(process.argv.slice(2));
