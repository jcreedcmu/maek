import * as child_process from 'child_process';
import * as os from 'os';
import { BuildError } from './build-error';

export const JOBS = os.cpus().length + 1;

//'job' says the contained function is an async job that should count against the JOBS limit:
// returns a promise that resolves to the result of jobFn() (or rejects if jobFn() throws)
// will always wait until at least the next tick to run jobFn()

type JobFn = () => any;

type Job = {
  jobFn: JobFn,
  resolve: (value: any) => void,
  reject: (reason: any) => void,
}

// keep count of active jobs and list of pending jobs:
let active: number = 0;
let pending: Job[] = [];

function job(jobFn: JobFn): Promise<void> {
  //helper that runs a job on the pending queue:
  async function schedule() {
    if (active < JOBS && pending.length) {
      active += 1;
      //DEBUG: console.log(`[${active}/${JOBS} active, ${pending.length} pending]`);
      const next = pending.shift()!; // we checked pending.length
      try {
        next.resolve(await next.jobFn());
      } catch (e) {
        next.reject(e);
      }
      active -= 1;
      process.nextTick(schedule);
    }
  }

  //make sure to check for executable jobs next tick:
  process.nextTick(schedule);

  //throw job onto pending queue:
  return new Promise<void>((resolve, reject) => {
    pending.push({ jobFn, resolve, reject });
  });
}

//runCommand runs a command:
export async function runCommand(command: string[], message: string): Promise<void> {
  await job(async () => {
    if (typeof message !== 'undefined') {
      console.log('\x1b[90m' + message + '\x1b[0m');
    }

    //print a command in a way that can be copied to a shell to run:
    let prettyCommand = '';
    for (const token of command) {
      if (prettyCommand !== '') prettyCommand += ' ';
      if (/[ \t\n!"'$&()*,;<>?[\\\]^`{|}~]/.test(token)
        || token[0] === '='
        || token[0] === '#') {
        //special characters => need to quote:
        prettyCommand += "'" + token.replace(/'/g, "'\\''") + "'";
      } else {
        prettyCommand += token;
      }
    }
    //console.log('   ' + prettyCommand);

    //package as a promise and await it finishing:
    await new Promise<void>((resolve, reject) => {
      const proc = child_process.spawn(command[0], command.slice(1), {
        shell: false,
        stdio: ['ignore', 'inherit', 'inherit']
      });
      proc.on('exit', (code, signal) => {
        if (code !== 0) {
          process.stderr.write(`\n`);
          reject(new BuildError(`exit ${code} from:\n    \x1b[31m${prettyCommand}\x1b[0m\n`));
        } else {
          (resolve as any)();
        }
      });
      proc.on('error', (err) => {
        reject(new BuildError(`${err.message} from:\n    ${prettyCommand}`));
      });
    });
  });
}
