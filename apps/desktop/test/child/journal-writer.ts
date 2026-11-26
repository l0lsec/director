// Child process for the crash-recovery test: journals one op every 10 ms forever and reports each ack.
import { createProjectBundle, openProjectBundle, ProjectSession } from '../../src/main/store/projectStore';
import { newProject } from '../../../../packages/engine/src/index';

const dir = process.argv[2]!;
createProjectBundle(dir, newProject({ name: 'crash test', id: 'proj_crash' }));
const session = new ProjectSession(dir, openProjectBundle(dir), 500);
let n = 0;
setInterval(() => {
  n++;
  const seq = session.journal([{ op: 'addMarker', marker: { id: `mk${n}`, t: n * 1000, kind: 'note', label: `marker ${n}` } }]);
  process.stdout.write(`ack ${seq} ${Date.now()}\n`);
}, 10);
