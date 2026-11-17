import { delimiter, dirname } from 'node:path';
import { prepareRunRoot } from './temp-root.ts';

// #296: tests here spawn `bun` by name. A suite started from an absolute bun path
// without bun on PATH would make those children fail for an environment reason, so
// the running binary is put first once, for the whole shell suite.
process.env.PATH = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);

// A worker killed with SIGKILL cannot run its exit hook; sweep stale run roots before this run
// starts. Roots owned by a live process are another run's, not garbage.
prepareRunRoot();
