import { Maek } from './maek';

const maek = new Maek();

//call rules on the maek object to specify tasks.
// rules generally look like:
//  output = maek.RULE_NAME(input [, output] [, {options}])

//the '[objFile =] CPP(cppFile [, objFileBase] [, options])' compiles a c++ file:
// cppFile: name of c++ file to compile
// objFileBase (optional): base name object file to produce (if not supplied, set to options.objDir + '/' + cppFile without the extension)
//returns objFile: objFileBase + a platform-dependant suffix ('.o' or '.obj')
const Player_obj = maek.CPP('Player.cpp');
const Level_obj = maek.CPP('Level.cpp');
const game_obj = maek.CPP('game.cpp');
const test_obj = maek.CPP('test.cpp');

//the '[exeFile =] LINK(objFiles, exeFileBase, [, options])' links an array of objects into an executable:
// objFiles: array of objects to link
// exeFileBase: name of executable file to produce
//returns exeFile: exeFileBase + a platform-dependant suffix (e.g., '.exe' on windows)
const game_exe = maek.LINK([game_obj, Player_obj, Level_obj], 'dist/game');
const test_exe = maek.LINK([test_obj, Player_obj, Level_obj], 'test/game-test');

//the '[targets =] RULE(targets, prerequisites[, recipe])' rule defines a Makefile-style task
// targets: array of targets the task produces (can include both files and ':abstract targets')
// prerequisites: array of targets the task waits on (can include both files and ':abstract targets')
// recipe (optional): array of commands to run (where each command is an array [exe, arg1, arg0, ...])
//returns targets: the targets the rule produces
maek.RULE([':test'], [test_exe], [
  [test_exe, '--all-tests']
]);

//Note that tasks that produce ':abstract targets' are never cached.
// This is similar to how .PHONY targets behave in make.

// - - - - - - - - - - - - - - - - - - - - - - - - -
//Now that the tasks are specified, decide which targets to build:

//by default, build the ':dist' abstract target:
let targets = [':dist'];

//but if anything is on the command line, build that instead:
if (process.argv.length > 2) {
  targets = process.argv.slice(2);
}

//note: this is an async function...
maek.update(targets);
//...which means it's not actually done here.
// (but node will wait until the function is done to exit)
