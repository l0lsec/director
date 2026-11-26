// M0 is the first milestone: nothing earlier to regress against beyond its own end-to-end check.
import { runChecks } from '../lib.mjs';
export default async () => runChecks(['node-0-e2e']);
