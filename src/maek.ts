import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import { posix as path } from 'path'; //NOTE: expect posix-style paths even on windows
import { BuildError } from './build-error';
import { JOBS, runCommand } from './jobs';

//cache file location:
const CACHE_FILE = path.join(__dirname, '../maek-cache.json');

const CPP_STD = '-std=c++2a';

const OS = (() => {
  const platform = os.platform();
  if (platform === 'win32') return 'windows';
  else if (platform === 'darwin') return 'macos';
  else if (platform === 'linux') return 'linux';
  else {
    console.error(`ERROR: Unrecognized platform ${os.platform()}.`);
    process.exit(1);
  }
})();

export type Options = {
  objPrefix: string, //prefix for object file paths (if not explicitly specified)
  objSuffix: string, //suffix for object files
  exeSuffix: string, //suffix for executable files
  depends: string[], //extra dependencies; generally only set locally
  CPPFlags: string[], //extra flags for c++ compiler
  LINKLibs: string[], //extra -L and -l flags for linker
}

type Partial<T> = {
  [P in keyof T]?: T[P];
};

const DEFAULT_OPTIONS: Options = {
  objPrefix: 'objs/',
  objSuffix: (OS === 'windows' ? '.obj' : '.o'),
  exeSuffix: (OS === 'windows' ? '.exe' : ''),
  depends: [],
  CPPFlags: [],
  LINKLibs: [],
};

export type Task = {
  run: () => Promise<void>,
  keyFn: undefined | (() => Promise<any>),
  label: string,
  src?: string,
  cachedKey?: string,
  pending?: Promise<void>,
  failed?: boolean,
}

export class Maek {
  options: Options;

  //this.tasks is a map from targets => tasks (possibly many-to-one):
  // a task is an async function that will make that target
  // (it will generally 'await' other tasks in the process)
  //
  // task.label is a human-readable name for the task (generally along the lines of "RULE 'source' -> 'target'")
  //
  // if task.keyFn is defined, it is used for caching (see below).
  // generally keyFn will return an array of the content hashes of all input and output files,
  // along with version information and parameters for external commands called by the script.


  //during the build process some additional properties will be set on tasks:
  // task.cachedKey is used for caching:
  //  - after a task is run, the result of its keyFn is stored in cachedKey
  //  - a task will skipped if the result of its keyFn matches the result already in cachedKey
  //  comparisons are performed using: JSON.stringify(await task.keyFn()) === JSON.stringify(task.cachedKey)
  //
  // task.cachedKey values are loaded into the this.tasks array from CACHE_FILE at the start of this.update,
  // and stored into CACHE_FILE at the end of this.update.
  //
  // task.pending is set by updateTargets() to keep track of currently-running task updates.
  tasks: Record<string, Task> = {};

  //used to avoid re-hashing the same files a whole lot:
  hashCache: Record<string, any> = {};
  hashCacheHits: number = 0;

  constructor() {
    //make it so that all paths/commands are relative to Maekfile.js:
    // (regardless of where you run it from)
    process.chdir(path.join(__dirname, ".."));

    //any settings here override 'DEFAULT_OPTIONS':
    this.options = Object.assign({}, DEFAULT_OPTIONS); //shallow copy of DEFAULT_OPTIONS in case you want to console.log(maek.options) to check settings.
  }

  combineOptions(localOptions: Partial<Options>): Options {
    return { ...DEFAULT_OPTIONS, ...this.options, ...localOptions };
  }

  // RULE adds a generic makefile-like task:
  // targets (array) are the things that get made
  // prerequisites (array) are the things that must be up-to-date before the recipe is run
  // recipe, optional (array) is a list of commands
  RULE(targets: string[], prerequisites: string[], recipe: string[][] = []) {

    let keyFn: undefined | (() => Promise<any>) = undefined;
    if (!targets.some(target => target[0] === ':')) { //(don't cache RULE's with abstract targets)
      keyFn = async () => {
        await this.updateTargets(prerequisites, `${task.label} (keyFn)`); //prerequisites need to be ready before they can be hashed!
        return [
          ...recipe,
          ...(await this.hashFiles([...targets, ...prerequisites]))
        ];
      };
    }

    const task: Task = {
      run: async () => {
        await this.updateTargets(prerequisites, `${task.label}`);
        let step = 1;
        for (const command of recipe) {
          await runCommand(command, `${task.label} (${step}/${recipe.length})`);
          step += 1;
        }
        for (const target of targets) {
          delete this.hashCache[target];
        }
      },
      label: `RULE ${targets[0]}`,
      keyFn,
    }

    for (const target of targets) {
      this.tasks[target] = task;
    }
  }

  // CPP makes an object from a c++ source file:
  // cppFile is the source file name
  // objFileBase (optional) is the output file (including any subdirectories, but not the extension)
  CPP(cppFile: string, objFileBase?: string, localOptions: Partial<Options> = {}) {
    //combine options:
    const options = this.combineOptions(localOptions);

    //if objFileBase isn't given, compute by trimming extension from cppFile and appending to objPrefix:
    if (typeof objFileBase === 'undefined') {
      objFileBase = path.relative('', options.objPrefix + cppFile.replace(/\.[^.]*$/, ''));
    }

    //object file gets os-dependent suffix:
    const objFile = objFileBase + options.objSuffix;

    //computed dependencies go in a '.d' file stored next to the object file:
    const depsFile = objFileBase + '.d';

    //explicit dependencies: (implicit dependencies will be computed later)
    const depends = [cppFile, ...options.depends];

    let cc: string[], depsCommand: string[], objCommand: string[];
    if (OS === 'linux') {
      cc = ['g++', CPP_STD, '-Wall', '-Werror', '-g', ...options.CPPFlags];
      depsCommand = [...cc, '-E', '-M', '-MG', '-MT', 'x ', '-MF', depsFile, cppFile];
      objCommand = [...cc, '-c', '-o', objFile, cppFile];
    } else if (OS === 'macos') {
      cc = ['clang++', CPP_STD, '-Wall', '-Werror', '-g', ...options.CPPFlags];
      depsCommand = [...cc, '-E', '-M', '-MG', '-MT', 'x ', '-MF', depsFile, cppFile];
      objCommand = [...cc, '-c', '-o', objFile, cppFile];
    } else {
      throw new Error(`TODO: write CPP rule for ${OS}.`);
    }

    //will be used by loadDeps to trim explicit dependencies:
    const inDepends: Record<string, boolean> = {};
    for (const d of depends) {
      inDepends[d] = true;
    }
    async function loadDeps() {
      let text;
      try {
        text = await fsPromises.readFile(depsFile, { encoding: 'utf8' });
      } catch (e) {
        return [];
      }

      //parse the makefile-style "targets : prerequisites" line from the file into a list of tokens:
      let tokens = text
        .replace(/\\?\n/g, ' ') //escaped newline (or regular newline) => whitespace
        .trim() //remove leading and trailing whitespace
        .replace(/([^\\])\s+/g, '$1\n') //run of non-escaped whitespace => single newline
        .split('\n'); //split on single newlines

      //becaue of the `-MT 'x '` option, expect 'x :' at the start of the rule:
      console.assert(tokens[0] === 'x');
      console.assert(tokens[1] === ':');
      tokens = tokens.slice(2); //remove the 'x :'
      tokens = tokens.sort(); //sort for consistency

      //NOTE: might want to do some path normalization here!
      const extraDepends = tokens.filter(target => !(target in inDepends));

      return extraDepends;
    }

    //The actual build task:
    const task: Task = {
      run: async () => {
        //first, wait for any explicit prerequisites to build:
        await this.updateTargets(depends, `${task.label}`);
        //make object file:
        delete this.hashCache[objFile];
        await fsPromises.mkdir(path.dirname(objFile), { recursive: true });
        await runCommand(objCommand, `${task.label}: compile`);
        //make dependencies file: (NOTE: could do with same compile line)
        delete this.hashCache[depsFile];
        await fsPromises.mkdir(path.dirname(depsFile), { recursive: true });
        await runCommand(depsCommand, `${task.label}: prerequisites`);
        //read extra dependencies and make sure they aren't targets of other rules:
        const extraDepends = await loadDeps();
        this.assertNontargets(extraDepends, `${task.label}`);
        //NOTE: if dynamic prerequisites are targets of other tasks there is a
        // problem whereby Maek can't know proper rule sequencing until it
        // has already run a rule.
      },

      keyFn: async () => {
        await this.updateTargets(depends, `${task.label} (keyFn)`);
        const extraDepends = await loadDeps();
        this.assertNontargets(extraDepends, `${task.label}`);
        return [
          objCommand, depsCommand,
          ...(await this.hashFiles([objFile, depsFile, ...depends, ...extraDepends]))
        ];
      },
      label: `CPP ${objFile}`
    }

    this.tasks[objFile] = task;

    return objFile;
  }

  //LINK links an executable file from a collection of object files:
  // objFiles is an array of object file names
  // exeFileBase is the base name of the executable file ('.exe' will be added on windows)
  LINK(objFiles: string[], exeFileBase: string, localOptions: Partial<Options> = {}) {
    const options = this.combineOptions(localOptions);

    const exeFile = exeFileBase + options.exeSuffix;

    let link: string[], linkCommand: string[];
    if (OS === 'linux') {
      link = ['g++', CPP_STD, '-Wall', '-Werror', '-g'];
      linkCommand = [...link, '-o', exeFile, ...objFiles, ...options.LINKLibs];
    } else if (OS === 'macos') {
      link = ['g++', CPP_STD, '-Wall', '-Werror', '-g'];
      linkCommand = [...link, '-o', exeFile, ...objFiles, ...options.LINKLibs];
    } else {
      throw new Error(`TODO: write LINK rule for ${OS}.`);
    }
    const depends = [...objFiles, ...options.depends];

    const task: Task = {
      run: async () => {
        //first, wait for all requested object files to build:
        await this.updateTargets(depends, `${task.label}`);

        //then link:
        delete this.hashCache[exeFile];
        await fsPromises.mkdir(path.dirname(exeFile), { recursive: true });
        await runCommand(linkCommand, `${task.label}: link`);
      },

      keyFn: async () => {
        await this.updateTargets(depends, `${task.label} (keyFn)`);
        return [
          linkCommand,
          ...(await this.hashFiles([exeFile, ...depends]))
        ];
      },
      label: `LINK ${exeFile}`
    };

    this.tasks[exeFile] = task;

    return exeFile;
  }

  async update(targets: string[]) {
    console.log(` -- Maek v0.1 on ${OS} with ${JOBS} max jobs updating '${targets.join("', '")}'...`);

    //clean up any stale cachedKey values:
    for (const target of Object.keys(this.tasks)) {
      delete this.tasks[target].cachedKey;
    }
    //load cachedKey values from cache file:
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, { encoding: 'utf8' }));
      let assigned = 0;
      let removed = 0;
      for (const target of Object.keys(cache)) {
        if (target in this.tasks) {
          this.tasks[target].cachedKey = cache[target];
          assigned += 1;
        } else {
          removed += 1;
        }
      }
      console.log(` -- Loaded cache from '${CACHE_FILE}'; assigned ${assigned} targets and removed ${removed} stale entries.`);
    } catch (e: any) {
      console.log(` --  No cache loaded; starting fresh.`);
      if (e.code !== 'ENOENT') {
        console.warn(`By the way, the reason the loading failed was the following unexpected error:`, e);
      }
    }

    //actually do the build:
    let failed = false;
    try {
      await this.updateTargets(targets, 'user');
      console.log(` -- SUCCESS: Targets are now up to date.`);
    } catch (e) {
      if (e instanceof BuildError) {
        console.error(` -- FAILED: ${e.message}`);
        process.exitCode = 1;
      } else {
        throw e;
      }
    }

    //store cachedKey values:
    const cache: Record<string, any> = {};
    let stored = 0;
    for (const target of Object.keys(this.tasks)) {
      if ('cachedKey' in this.tasks[target]) {
        cache[target] = this.tasks[target].cachedKey;
        stored += 1;
      }
    }
    console.log(` -- Writing cache with ${stored} entries to '${CACHE_FILE}'...`);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), { encoding: 'utf8' });

    console.log(` -- hashCache ended up with ${Object.keys(this.hashCache).length} items and handled ${this.hashCacheHits} hits.`);
  }

  //return a ['file:base64hash', 'file2:whateverHash', 'file3:etcstuff'] array,
  // representing the contents of a list of targets (with ':abstract' targets removed)
  async hashFiles(targets: string[]) {
    const files = targets.filter(target => target[0] !== ':');

    //helper that will hash a single file: (non-existent files get special hash 'x')
    const hashFile = async (file: string) => {
      if (file in this.hashCache) {
        this.hashCacheHits += 1;
        return this.hashCache[file];
      }

      //would likely be more efficient to use a pipe with large files,
      //but this code is a bit more readable:
      const hash = await new Promise((resolve, reject) => {
        fs.readFile(file, (err, data) => {
          if (err) {
            //if failed to read file, report hash as 'x':
            resolve(`${file}:x`);
          } else {
            //otherwise, report base64-encoded md5sum of file data:
            const hash = crypto.createHash('md5');
            hash.update(data);
            resolve(`${file}:${hash.digest('base64')}`);
          }
        });
      });

      this.hashCache[file] = hash;
      return hash;
    }

    //get all hashes:
    return await Promise.all(files.map(hashFile));
  }

  //updateTargets takes a list of targets and updates them as needed.
  async updateTargets(targets: string[], src: string) {
    const pending = [];
    for (const target of targets) {
      //if target has an associated task, wait on that task:
      const task = this.tasks[target];
      if (task !== undefined) {
        // launch task if not already pending:
        if (!('pending' in task)) {
          task.src = src;
          task.pending = (async () => {
            try {
              //check for cache hit:
              if (task.cachedKey !== undefined && task.keyFn !== undefined) {
                const key = await task.keyFn();
                if (JSON.stringify(key) === JSON.stringify(task.cachedKey)) {
                  //TODO: VERBOSE: console.log(`${task.label}: already in cache.`);
                  return;
                }
              }
              //on cache miss, run task:
              await task.run();
              //and update cache:
              if (task.keyFn !== undefined) {
                task.cachedKey = await task.keyFn();
              }
            } catch (e) {
              if (e instanceof BuildError) {
                console.error(`!!! FAILED [${task.label}] ${e.message}`);
                task.failed = true;
              } else {
                throw e;
              }
            }
          })();
        }
        pending.push(task.pending);
        //otherwise, if target is abstract, complain because it isn't known:
      } else if (target[0] === ':') {
        throw new BuildError(`Target '${target}' (requested by ${src}) is abstract but doesn't have a task.`);
        //otherwise, target is a file, so check that it exists:
      } else {
        pending.push(
          fsPromises.access(target, fs.constants.R_OK).catch((e) => {
            throw new BuildError(`Target '${target}' (requested by ${src}) doesn't exist and doesn't have a task to make it.`);
          })
        );
      }
    }

    //resolve all the build/check tasks before returning:
    await Promise.all(pending);

    //check for any build failures:
    for (const target of targets) {
      if (target in this.tasks) {
        if (this.tasks[target].failed) {
          throw new BuildError(`for lack of ${target}`);
        }
      }
    }
  }

  //assertNontargets makes sure none of the mentioned prerequisites are targets of tasks:
  assertNontargets(prerequisites: string[], ruleName: string) {
    let errorFiles = [];
    for (const target of prerequisites) {
      if (target in this.tasks) {
        errorFiles.push(target);
      }
    }
    if (errorFiles.length) {
      throw new BuildError(`the following *generated* files are required but not mentioned as dependancies:\n  ${errorFiles.join('\n  ')}`);
    }
  }
}
