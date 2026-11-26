import { runChecks } from '../lib.mjs';
// Every earlier milestone end to end, plus the M6 bridge checks the agent server replaced.
export default async () => runChecks(['node-0-e2e', 'node-1-e2e', 'node-2-e2e', 'node-3-e2e', 'node-4-e2e', 'node-5-e2e', 'node-6-e2e', 'node-7-e2e', 'l6.5-tools', 'l6.5-security', 'l6.5-confirm']);
