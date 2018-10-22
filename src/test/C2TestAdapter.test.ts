//-----------------------------------------------------------------------------
// vscode-catch2-test-adapter was written by Mate Pek, and is placed in the
// public domain. The author hereby disclaims copyright to this source code.

const child_process = require('child_process');
const deepStrictEqual = require('deep-equal');

import * as path from 'path';
import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import {EventEmitter} from 'events';
import {TestEvent, TestLoadFinishedEvent, TestLoadStartedEvent, TestRunFinishedEvent, TestRunStartedEvent, TestSuiteEvent, TestSuiteInfo, TestInfo, TestAdapter} from 'vscode-test-adapter-api';
import {Log} from 'vscode-test-adapter-util';
import {inspect} from 'util';

import {C2AllTestSuiteInfo} from '../C2AllTestSuiteInfo';
import {C2TestAdapter} from '../C2TestAdapter';
import {example1} from './example1';
import {ChildProcessStub} from './Helpers';
import * as c2fs from '../FsWrapper';

assert.notEqual(vscode.workspace.workspaceFolders, undefined);
assert.equal(vscode.workspace.workspaceFolders!.length, 1);

const workspaceFolderUri = vscode.workspace.workspaceFolders![0].uri;

const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(workspaceFolderUri)!;

const workspaceFolderMatcher =
    sinon.match(new RegExp('out(/|\\\\)test'))
        .and(sinon.match(new RegExp('^((?!\\.vscode).)*$')));

const logger =
    new Log('Catch2TestAdapter', workspaceFolder, 'Catch2TestAdapter');

const dotVscodePath = path.join(workspaceFolderUri.path, '.vscode');

const sinonSandbox = sinon.createSandbox();

///

describe('C2TestAdapter', function() {
  function getConfig() {
    return vscode.workspace.getConfiguration(
        'catch2TestExplorer', workspaceFolderUri)
  };

  function updateConfig(key: string, value: any) {
    return getConfig().update(key, value)
  }

  let adapter: C2TestAdapter|undefined;
  let testsEvents: (TestLoadStartedEvent|TestLoadFinishedEvent)[];
  let testsEventsConnection: vscode.Disposable|undefined;
  let testStatesEvents: (TestRunStartedEvent|TestRunFinishedEvent|
                         TestSuiteEvent|TestEvent)[];
  let testStatesEventsConnection: vscode.Disposable|undefined;

  let spawnStub: sinon.SinonStub;
  let fsWatchStub: sinon.SinonStub;
  let fsExistsStub: sinon.SinonStub;
  let c2fsReaddirSyncStub: sinon.SinonStub;
  let c2fsStatSyncStub: sinon.SinonStub;

  function resetConfig(): Thenable<void> {
    const packageJson = fse.readJSONSync(
        path.join(workspaceFolderUri.path, '../..', 'package.json'));
    const properties: {[prop: string]: any}[] =
        packageJson['contributes']['configuration']['properties'];
    let t: Thenable<void> = Promise.resolve();
    Object.keys(properties).forEach(key => {
      assert.ok(key.startsWith('catch2TestExplorer.'));
      const k = key.replace('catch2TestExplorer.', '')
      t = t.then(() => {
        return getConfig().update(k, undefined);
      });
    });
    return t;
  }

  function testStatesEvI(o: any) {
    const i = testStatesEvents.findIndex(
        (v: TestRunStartedEvent|TestRunFinishedEvent|TestSuiteEvent|
         TestEvent) => {
          if (o.type == v.type)
            if (o.type == 'suite' || o.type == 'test')
              return o.state === (<TestSuiteEvent|TestEvent>v).state &&
                  o[o.type] === (<any>v)[v.type];
          return deepStrictEqual(o, v);
        });
    assert.notEqual(
        i, -1,
        'testStatesEvI failed to find: ' + inspect(o) + '\n\nin\n\n' +
            inspect(testStatesEvents));
    assert.deepStrictEqual(testStatesEvents[i], o);
    return i;
  };

  function createAdapterAndSubscribe() {
    adapter = new C2TestAdapter(workspaceFolder, logger);

    testsEvents = [];
    testsEventsConnection =
        adapter.tests((e: TestLoadStartedEvent|TestLoadFinishedEvent) => {
          testsEvents.push(e);
        });

    testStatesEvents = [];
    testStatesEventsConnection = adapter.testStates(
        (e: TestRunStartedEvent|TestRunFinishedEvent|TestSuiteEvent|
         TestEvent) => {
          testStatesEvents.push(e);
        });

    return adapter!;
  }

  function disposeAdapterAndSubscribers() {
    adapter && adapter.dispose();
    testsEventsConnection && testsEventsConnection.dispose();
    testStatesEventsConnection && testStatesEventsConnection.dispose();
    testsEvents = [];
    testStatesEvents = [];
  }

  function stubsThrowByDefault() {
    spawnStub.withArgs(workspaceFolderMatcher).callsFake((...args: any[]) => {
      throw new Error(inspect(['spawnStub', args]));
    });
    fsWatchStub.withArgs(workspaceFolderMatcher).callsFake((...args: any[]) => {
      throw new Error(inspect(['fsWatchStub', args]));
    });
    fsExistsStub.withArgs(workspaceFolderMatcher)
        .callsFake((...args: any[]) => {
          throw new Error(inspect(['fsExistsStub', args]));
        });
  }

  function stubsResetToThrow() {
    spawnStub.reset();
    fsWatchStub.reset();
    fsExistsStub.reset();
    c2fsReaddirSyncStub.reset();
    c2fsStatSyncStub.reset();
    stubsThrowByDefault();
    // TODO stub.callThrough();
  }

  before(() => {
    fse.removeSync(dotVscodePath);
    adapter = undefined;

    spawnStub = sinonSandbox.stub(child_process, 'spawn');
    fsWatchStub = sinonSandbox.stub(fs, 'watch');
    fsExistsStub = sinonSandbox.stub(fs, 'exists');
    c2fsReaddirSyncStub = sinonSandbox.stub(c2fs, 'readdirSync');
    c2fsStatSyncStub = sinonSandbox.stub(c2fs, 'statSync');

    stubsResetToThrow();

    // reset config can cause problem with fse.removeSync(dotVscodePath);
    return resetConfig();
  });

  after(() => {
    disposeAdapterAndSubscribers();
    sinonSandbox.restore();
  });

  describe('detect config change', function() {
    this.slow(150);

    const waitForReloadAndAssert = (): Promise<void> => {
      const waitForReloadAndAssertInner = (tryCount: number): Promise<void> => {
        if (testsEvents.length < 2)
          return new Promise<void>(r => setTimeout(r, 10))
              .then(() => {waitForReloadAndAssertInner(tryCount - 1)});
        else {
          assert.equal(testsEvents.length, 2);
          assert.equal(testsEvents[0].type, 'started');
          assert.equal(testsEvents[1].type, 'finished');
          const suite = (<TestLoadFinishedEvent>testsEvents[1]).suite;
          assert.notEqual(suite, undefined);
          assert.equal(suite!.children.length, 0);
          return Promise.resolve();
        }
      };
      return waitForReloadAndAssertInner(20);
    };

    afterEach(() => {
      disposeAdapterAndSubscribers();
      return resetConfig();
    });

    it('workerMaxNumber', () => {
      createAdapterAndSubscribe();
      assert.deepStrictEqual(testsEvents, []);
      return getConfig()
          .update('workerMaxNumber', 42)
          .then(waitForReloadAndAssert);
    });

    it('defaultEnv', () => {
      createAdapterAndSubscribe();
      assert.deepStrictEqual(testsEvents, []);
      return getConfig()
          .update('defaultEnv', {'APPLE': 'apple'})
          .then(waitForReloadAndAssert);
    });

    it('defaultCwd', () => {
      createAdapterAndSubscribe();
      assert.deepStrictEqual(testsEvents, []);
      return getConfig()
          .update('defaultCwd', 'apple/peach')
          .then(waitForReloadAndAssert);
    });

    it('enableSourceDecoration', () => {
      const adapter = createAdapterAndSubscribe();
      assert.deepStrictEqual(testsEvents, []);
      return getConfig().update('enableSourceDecoration', false).then(() => {
        assert.ok(!adapter.getIsEnabledSourceDecoration());
      });
    });

    it('defaultRngSeed', () => {
      const adapter = createAdapterAndSubscribe();
      assert.deepStrictEqual(testsEvents, []);
      return getConfig().update('defaultRngSeed', 987).then(() => {
        assert.equal(adapter.getRngSeed(), 987);
      });
    });
  });
  // describe('detect config change'

  describe('adapter:', () => {
    let adapter: C2TestAdapter;

    beforeEach(() => {
      adapter = createAdapterAndSubscribe();
    });

    afterEach(() => {
      disposeAdapterAndSubscribers();
    });

    it('fill with empty config', function() {
      return adapter.load().then(() => {
        assert.equal(testsEvents.length, 2);
        assert.equal(testsEvents[0].type, 'started');
        assert.equal(testsEvents[1].type, 'finished');
        const suite = (<TestLoadFinishedEvent>testsEvents[1]).suite;
        assert.notEqual(suite, undefined);
        assert.equal(suite!.children.length, 0);
      });
    });

    describe('example1', function() {
      let tests: any;

      before(() => {
        for (let suite of example1.outputs) {
          for (let scenario of suite[1]) {
            spawnStub.withArgs(suite[0], scenario[0]).callsFake(() => {
              return new ChildProcessStub(scenario[1]);
            });
          }
        }
      })

      after(() => {
        stubsResetToThrow();
      });

      beforeEach(() => {
        return adapter.load()
            .then(() => {
              const root = (<TestLoadFinishedEvent>testsEvents[1]).suite;
              assert.notEqual(undefined, root);
              return root!;
            })
            .then((suite: TestSuiteInfo) => {
              const root = <C2AllTestSuiteInfo>suite;
              const s1 =
                  root.createChildSuite('s1', example1.suite1.execPath, {});
              const s1t1 = s1.createChildTest(
                  's1t1', 'd', ['tag1'], example1.suite1.execPath, 1);
              const s1t2 = s1.createChildTest(
                  's1t2', 'd', ['tag1'], example1.suite1.execPath, 2);
              const s2 =
                  root.createChildSuite('s2', example1.suite2.execPath, {});
              const s2t1 = s2.createChildTest(
                  's2t1', 'd', ['tag1'], example1.suite2.execPath, 1);
              const s2t2 = s2.createChildTest(
                  's2t2', 'd', ['[.]'], example1.suite2.execPath, 2);
              const s2t3 = s2.createChildTest(
                  's2t3', 'd', ['tag1'], example1.suite2.execPath, 3);

              tests = {
                root: root,
                s1: s1,
                s1t1: s1t1,
                s1t2: s1t2,
                s2: s2,
                s2t1: s2t1,
                s2t2: s2t2,
                s2t3: s2t3
              }
            });
      })

      it('run: 1 test (succ)', function() {
        return adapter.run([tests.s1t1.id]).then(() => {
          assert.deepStrictEqual(testStatesEvents, [
            {type: 'started', tests: [tests.s1t1.id]},
            {type: 'suite', state: 'running', suite: tests.s1},
            {type: 'test', state: 'running', test: tests.s1t1},
            {
              type: 'test',
              state: 'passed',
              test: tests.s1t1,
              decorations: undefined,
              message: 'Duration: 0.000112 second(s)\n'
            },
            {type: 'suite', state: 'completed', suite: tests.s1},
            {type: 'finished'},
          ]);
        });
      })

      it('run: 1 test (skipped)', function() {
        return adapter.run([tests.s2t2.id]).then(() => {
          assert.deepStrictEqual(testStatesEvents, [
            {type: 'started', tests: [tests.s2t2.id]},
            {type: 'suite', state: 'running', suite: tests.s2},
            {type: 'test', state: 'running', test: tests.s2t2},
            {
              type: 'test',
              state: 'passed',
              test: tests.s2t2,
              decorations: undefined,
              message: 'Duration: 0.001294 second(s)\n'
            },
            {type: 'suite', state: 'completed', suite: tests.s2},
            {type: 'finished'},
          ]);
        });
      });
      // it('run: 1 test (skipped)'

      it('run: 1 test (fails)', function() {
        return adapter.run([tests.s2t3.id]).then(() => {
          assert.deepStrictEqual(testStatesEvents, [
            {type: 'started', tests: [tests.s2t3.id]},
            {type: 'suite', state: 'running', suite: tests.s2},
            {type: 'test', state: 'running', test: tests.s2t3},
            {
              type: 'test',
              state: 'failed',
              test: tests.s2t3,
              decorations: [{line: 20, message: 'Expanded: false'}],
              message:
                  'Duration: 0.000596 second(s)\n>>> s2t3(line: 19) REQUIRE (line: 21) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
            },
            {type: 'suite', state: 'completed', suite: tests.s2},
            {type: 'finished'},
          ]);
        });
      });
      // it('run: 1 test (fails)'

      it('run: s2t3 with chunks', function() {
        const withArgs = spawnStub.withArgs(
            tests.s2.execPath, example1.suite2.t3.outputs[0][0]);
        withArgs.onCall(withArgs.callCount)
            .returns(new ChildProcessStub(example1.suite2.t3.outputs[0][1]));

        return adapter.run([tests.s2t3.id]).then(() => {
          assert.deepStrictEqual(testStatesEvents, [
            {type: 'started', tests: [tests.s2t3.id]},
            {type: 'suite', state: 'running', suite: tests.s2},
            {type: 'test', state: 'running', test: tests.s2t3},
            {
              type: 'test',
              state: 'failed',
              test: tests.s2t3,
              decorations: [{line: 20, message: 'Expanded: false'}],
              message:
                  'Duration: 0.000596 second(s)\n>>> s2t3(line: 19) REQUIRE (line: 21) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
            },
            {type: 'suite', state: 'completed', suite: tests.s2},
            {type: 'finished'},
          ]);
        });
      });
      // it('run: 1 test (fails) with chunks'

      it('run: suite1 (1 succ 1 fails)', function() {
        return adapter.run([tests.s1.id]).then(() => {
          assert.deepStrictEqual(testStatesEvents, [
            {type: 'started', tests: [tests.s1.id]},
            {type: 'suite', state: 'running', suite: tests.s1},
            {type: 'test', state: 'running', test: tests.s1t1},
            {
              type: 'test',
              state: 'passed',
              test: tests.s1t1,
              decorations: undefined,
              message: 'Duration: 0.000132 second(s)\n'
            },
            {type: 'test', state: 'running', test: tests.s1t2},
            {
              type: 'test',
              state: 'failed',
              test: tests.s1t2,
              decorations: [{line: 14, message: 'Expanded: false'}],
              message:
                  'Duration: 0.000204 second(s)\n>>> s1t2(line: 13) REQUIRE (line: 15) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
            },
            {type: 'suite', state: 'completed', suite: tests.s1},
            {type: 'finished'},
          ]);
        });
      });
      // it('run: suite1 (1 succ 1 fails)'

      it('run: root (at least 2 slots)', function() {
        return adapter.run([tests.root.id]).then(() => {
          assert.deepStrictEqual(
              {type: 'started', tests: [tests.root.id]}, testStatesEvents[0]);
          assert.deepStrictEqual(
              {type: 'finished'},
              testStatesEvents[testStatesEvents.length - 1]);

          const s1running = {type: 'suite', state: 'running', suite: tests.s1};
          const s1finished = {
            type: 'suite',
            state: 'completed',
            suite: tests.s1
          };
          assert.ok(testStatesEvI(s1running) < testStatesEvI(s1finished));

          const s2running = {type: 'suite', state: 'running', suite: tests.s2};
          const s2finished = {
            type: 'suite',
            state: 'completed',
            suite: tests.s2
          };
          assert.ok(testStatesEvI(s2running) < testStatesEvI(s2finished));

          const s1t1running = {
            type: 'test',
            state: 'running',
            test: tests.s1t1
          };
          assert.ok(testStatesEvI(s1running) < testStatesEvI(s1t1running));

          const s1t1finished = {
            type: 'test',
            state: 'passed',
            test: tests.s1t1,
            decorations: undefined,
            message: 'Duration: 0.000132 second(s)\n'
          };
          assert.ok(testStatesEvI(s1t1running) < testStatesEvI(s1t1finished));
          assert.ok(testStatesEvI(s1t1finished) < testStatesEvI(s1finished));

          const s1t2running = {
            type: 'test',
            state: 'running',
            test: tests.s1t2
          };
          assert.ok(testStatesEvI(s1running) < testStatesEvI(s1t2running));

          const s1t2finished = {
            type: 'test',
            state: 'failed',
            test: tests.s1t2,
            decorations: [{line: 14, message: 'Expanded: false'}],
            message:
                'Duration: 0.000204 second(s)\n>>> s1t2(line: 13) REQUIRE (line: 15) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
          };
          assert.ok(testStatesEvI(s1t2running) < testStatesEvI(s1t2finished));
          assert.ok(testStatesEvI(s1t2finished) < testStatesEvI(s1finished));

          const s2t1running = {
            type: 'test',
            state: 'running',
            test: tests.s2t1
          };
          assert.ok(testStatesEvI(s2running) < testStatesEvI(s2t1running));

          const s2t1finished = {
            type: 'test',
            state: 'passed',
            test: tests.s2t1,
            decorations: undefined,
            message: 'Duration: 0.00037 second(s)\n'
          };
          assert.ok(testStatesEvI(s2t1running) < testStatesEvI(s2t1finished));
          assert.ok(testStatesEvI(s2t1finished) < testStatesEvI(s2finished));

          const s2t2running = {
            type: 'test',
            state: 'running',
            test: tests.s2t2
          };
          assert.ok(testStatesEvI(s2running) < testStatesEvI(s2t2running));

          const s2t2finished = {
            type: 'test',
            state: 'skipped',
            test: tests.s2t2
          };
          assert.ok(testStatesEvI(s2t2running) < testStatesEvI(s2t2finished));
          assert.ok(testStatesEvI(s2t2finished) < testStatesEvI(s2finished));

          const s2t3running = {
            type: 'test',
            state: 'running',
            test: tests.s2t3
          };
          assert.ok(testStatesEvI(s2running) < testStatesEvI(s2t3running));

          const s2t3finished = {
            type: 'test',
            state: 'failed',
            test: tests.s2t3,
            decorations: [{line: 20, message: 'Expanded: false'}],
            message:
                'Duration: 0.000178 second(s)\n>>> s2t3(line: 19) REQUIRE (line: 21) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
          };
          assert.ok(testStatesEvI(s2t3running) < testStatesEvI(s2t3finished));
          assert.ok(testStatesEvI(s2t3finished) < testStatesEvI(s2finished));

          assert.equal(testStatesEvents.length, 16, inspect(testStatesEvents));
        });
      })

      it('run: wrong xml 1', async function() {
        const m = example1.suite1.t1.outputs[0][1].match('<TestCase[^>]+>');
        assert.notEqual(m, undefined);
        assert.notEqual(m!.input, undefined);
        assert.notEqual(m!.index, undefined);
        const part = m!.input!.substr(0, m!.index! + m![0].length);
        const withArgs = spawnStub.withArgs(
            tests.s1.execPath, example1.suite1.t1.outputs[0][0]);
        withArgs.onCall(withArgs.callCount).returns(new ChildProcessStub(part));

        await adapter.run([tests.s1t1.id]);

        const expected = [
          {type: 'started', tests: [tests.s1t1.id]},
          {type: 'suite', state: 'running', suite: tests.s1},
          {type: 'test', state: 'running', test: tests.s1t1},
          {
            type: 'test',
            state: 'failed',
            test: tests.s1t1,
            message: 'Unexpected test error. (Is Catch2 crashed?)\n'
          },
          {type: 'suite', state: 'completed', suite: tests.s1},
          {type: 'finished'},
        ];
        assert.deepStrictEqual(testStatesEvents, expected);

        // this tests the sinon stubs too
        await adapter.run([tests.s1t1.id]);
        assert.deepStrictEqual(testStatesEvents, [
          ...expected,
          {type: 'started', tests: [tests.s1t1.id]},
          {type: 'suite', state: 'running', suite: tests.s1},
          {type: 'test', state: 'running', test: tests.s1t1},
          {
            type: 'test',
            state: 'passed',
            test: tests.s1t1,
            decorations: undefined,
            message: 'Duration: 0.000112 second(s)\n'
          },
          {type: 'suite', state: 'completed', suite: tests.s1},
          {type: 'finished'},
        ]);
      })

      it('cancel: empty', function() {
        adapter.cancel();
      })

      it('cancel', function() {
        const suite1Kill = sinon.spy();
        const suite2Kill = sinon.spy();
        {
          const spawnEvent =
              new ChildProcessStub(example1.suite1.outputs[2][1]);
          spawnEvent.kill = suite1Kill;
          spawnStub
              .withArgs(
                  tests.s1.execPath,
                  ['--reporter', 'xml', '--durations', 'yes'],
                  tests.s1.execOptions)
              .returns(spawnEvent);
        }
        {
          const spawnEvent =
              new ChildProcessStub(example1.suite2.outputs[2][1]);
          spawnEvent.kill = suite2Kill;
          spawnStub
              .withArgs(
                  tests.s2.execPath,
                  ['--reporter', 'xml', '--durations', 'yes'],
                  tests.s2.execOptions)
              .returns(spawnEvent);
        }
        const run = adapter.run([tests.root.id]);
        adapter.cancel();
        run.then(() => {
          assert.deepStrictEqual(
              testStatesEvents,
              [{type: 'started', tests: [tests.root.id]}, {type: 'finished'}]);
          assert.equal(suite1Kill.callCount, 1);
          assert.equal(suite2Kill.callCount, 1);
        });
      })

      it('cancel: after run finished', function() {
        const suite1Kill = sinon.spy();
        const suite2Kill = sinon.spy();
        {
          const spawnEvent =
              new ChildProcessStub(example1.suite1.outputs[2][1]);
          spawnEvent.kill = suite1Kill;
          spawnStub
              .withArgs(
                  tests.s1.execPath,
                  ['--reporter', 'xml', '--durations', 'yes'],
                  tests.s1.execOptions)
              .returns(spawnEvent);
        }
        {
          const spawnEvent =
              new ChildProcessStub(example1.suite2.outputs[2][1]);
          spawnEvent.kill = suite2Kill;
          spawnStub
              .withArgs(
                  tests.s2.execPath,
                  ['--reporter', 'xml', '--durations', 'yes'],
                  tests.s2.execOptions)
              .returns(spawnEvent);
        }
        const run = adapter.run([tests.root.id]);
        run.then(() => {
          adapter.cancel();
          assert.equal(suite1Kill.callCount, 0);
          assert.equal(suite2Kill.callCount, 0);
        });
      })
    })
  })

  describe('executables:', function() {
    this.slow(150);
    const cwd = path.join(process.cwd(), 'out', 'test');

    afterEach(() => {
      disposeAdapterAndSubscribers();
      stubsResetToThrow();
      return resetConfig();
    });

    const updateAndVerify = (value: any, expected: any[]) => {
      return getConfig()
          .update('executables', value)
          .then(() => {
            const adapter = createAdapterAndSubscribe();

            const verifyIsCatch2TestExecutable =
                sinonSandbox.stub(adapter, 'verifyIsCatch2TestExecutable');
            verifyIsCatch2TestExecutable.returns(Promise.resolve(true));

            const loadSuiteMock = sinon.expectation.create('loadSuiteMock');
            loadSuiteMock.exactly(expected.length).returns(Promise.resolve())
            sinonSandbox.replace(adapter, 'loadSuite', loadSuiteMock);

            return adapter.load().then(() => {
              return loadSuiteMock;
            });
          })
          .then((loadSuiteMock) => {
            assert.equal(testsEvents.length, 2);
            loadSuiteMock.verify();
            const calls = loadSuiteMock.getCalls();
            const args = calls.map((call: any) => {
              const arg = call.args[0];
              const filteredKeys =
                  Object.keys(arg.env).filter(k => k.startsWith('C2TEST'));
              const newEnv: {[prop: string]: string} = {};
              filteredKeys.forEach((k: string) => {
                newEnv[k] = arg.env[k];
              })
              arg.env = newEnv;
              return arg;
            });
            assert.deepEqual(args, expected);
          });
    };

    it('"exe1.exe"', () => {
      return updateAndVerify('exe1.exe', [{
                               name: 'exe1.exe',
                               path: path.join(cwd, 'exe1.exe'),
                               regex: '',
                               cwd: cwd,
                               env: {}
                             }]);
    });

    it('["exe1.exe", "exe2.exe"]', () => {
      return updateAndVerify(['exe1.exe', 'exe2.exe'], [
        {
          name: 'exe1.exe',
          path: path.join(cwd, 'exe1.exe'),
          regex: '',
          cwd: cwd,
          env: {}
        },
        {
          name: 'exe2.exe',
          path: path.join(cwd, 'exe2.exe'),
          regex: '',
          cwd: cwd,
          env: {}
        }
      ]);
    });

    it('{path: "path1"}', () => {
      return updateAndVerify({path: 'path1'}, [{
                               name: '${dirname} : ${name}',
                               path: path.join(cwd, 'path1'),
                               regex: '',
                               cwd: cwd,
                               env: {}
                             }]);
    });
  })

  describe('load: example1', function() {
    before(() => {
      for (let suite of example1.outputs) {
        for (let scenario of suite[1]) {
          spawnStub.withArgs(suite[0], scenario[0]).callsFake(() => {
            return new ChildProcessStub(scenario[1]);
          });
        }
      }

      const exists = (path: string) => {
        return example1.outputs.findIndex((v) => {
          return v[0] == path;
        }) != -1;
      };

      fsExistsStub.withArgs(workspaceFolderMatcher)
          .callsFake(function(
              path: string, cb: (err: any, exists: boolean) => void) {
            cb(undefined, exists(path));
          });

      fsWatchStub.withArgs(workspaceFolderMatcher).callsFake((path: string) => {
        if (exists(path)) {
          const ee = new class extends EventEmitter {
            close() {}
          };
          watchEvents.set(path, ee);
          return ee;
        } else {
          throw Error('File not found?');
        }
      });

      const dirContent: Map<string, string[]> = new Map();
      for (let p of example1.outputs) {
        const parent = path.dirname(p[0]);
        let children: string[] = [];
        if (dirContent.has(parent))
          children = dirContent.get(parent)!;
        else
          dirContent.set(parent, children);
        children.push(path.basename(p[0]));
      }

      dirContent.forEach((v: string[], k: string) => {
        c2fsReaddirSyncStub.withArgs(k).returns(v);
      });

      c2fsStatSyncStub.callsFake((p: string) => {
        if (dirContent.has(p))
          return {
            isFile() {
              return false;
            },
            isDirectory() {
              return true;
            }
          };
        const pa = dirContent.get(path.dirname(p));
        if (pa != undefined && pa.indexOf(path.basename(p)) != -1)
          return {
            isFile() {
              return true;
            },
            isDirectory() {
              return false;
            }
          };
        throw Error(inspect(['c2fsStatSyncStub', p]));
      });
    })

    after(() => {
      stubsResetToThrow();
    })

    const uniqueIdC = new Set<string>();
    const watchEvents: Map<string, EventEmitter> = new Map();
    let adapter: TestAdapter;
    let root: TestSuiteInfo;

    beforeEach(async function() {
      adapter = createAdapterAndSubscribe();
      await adapter.load();

      assert.equal(testsEvents.length, 2, inspect(testsEvents));
      assert.equal(testsEvents[1].type, 'finished');
      assert.ok((<TestLoadFinishedEvent>testsEvents[1]).suite);
      root = (<TestLoadFinishedEvent>testsEvents[1]).suite!;
      testsEvents.pop();
      testsEvents.pop();

      example1.assertWithoutChildren(root, uniqueIdC);
      assert.deepStrictEqual(testStatesEvents, []);
    });

    afterEach(() => {
      uniqueIdC.clear();
      watchEvents.clear();
      disposeAdapterAndSubscribers();
    });

    context('executables="execPath1"', function() {
      before(() => {
        return updateConfig('executables', 'execPath1');
      });

      after(() => {
        return updateConfig('executables', undefined);
      });

      let suite1: TestSuiteInfo;
      let s1t1: TestInfo;
      let s1t2: TestInfo;

      beforeEach(async function() {
        assert.deepStrictEqual(
            getConfig().get<any>('executables'), 'execPath1');
        assert.equal(root.children.length, 1);
        assert.equal(root.children[0].type, 'suite');
        suite1 = <TestSuiteInfo>root.children[0];
        example1.suite1.assert(
            'execPath1', ['s1t1', 's1t2'], suite1, uniqueIdC);
        assert.equal(suite1.children.length, 2);
        assert.equal(suite1.children[0].type, 'test');
        s1t1 = <TestInfo>suite1.children[0];
        assert.equal(suite1.children[1].type, 'test');
        s1t2 = <TestInfo>suite1.children[1];
      });

      it('should run with not existing test id', async function() {
        await adapter.run(['not existing id']);

        assert.deepStrictEqual(testStatesEvents, [
          {type: 'started', tests: ['not existing id']},
          {type: 'finished'},
        ]);
      });

      it('should run s1t1 with success', async function() {
        assert.equal(getConfig().get<any>('executables'), 'execPath1');
        await adapter.run([s1t1.id]);
        const expected = [
          {type: 'started', tests: [s1t1.id]},
          {type: 'suite', state: 'running', suite: suite1},
          {type: 'test', state: 'running', test: s1t1},
          {
            type: 'test',
            state: 'passed',
            test: s1t1,
            decorations: undefined,
            message: 'Duration: 0.000112 second(s)\n'
          },
          {type: 'suite', state: 'completed', suite: suite1},
          {type: 'finished'},
        ];
        assert.deepStrictEqual(testStatesEvents, expected);

        await adapter.run([s1t1.id]);
        assert.deepStrictEqual(testStatesEvents, [...expected, ...expected]);
      });

      it('should run suite1', async function() {
        await adapter.run([suite1.id]);
        const expected = [
          {type: 'started', tests: [suite1.id]},
          {type: 'suite', state: 'running', suite: suite1},
          {type: 'test', state: 'running', test: s1t1},
          {
            type: 'test',
            state: 'passed',
            test: s1t1,
            decorations: undefined,
            message: 'Duration: 0.000132 second(s)\n'
          },
          {type: 'test', state: 'running', test: s1t2},
          {
            type: 'test',
            state: 'failed',
            test: s1t2,
            decorations: [{line: 14, message: 'Expanded: false'}],
            message:
                'Duration: 0.000204 second(s)\n>>> s1t2(line: 13) REQUIRE (line: 15) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
          },
          {type: 'suite', state: 'completed', suite: suite1},
          {type: 'finished'},
        ];
        assert.deepStrictEqual(testStatesEvents, expected);

        await adapter.run([suite1.id]);
        assert.deepStrictEqual(testStatesEvents, [...expected, ...expected]);
      });

      it('should run all', async function() {
        await adapter.run([root.id]);
        const expected = [
          {type: 'started', tests: [root.id]},
          {type: 'suite', state: 'running', suite: suite1},
          {type: 'test', state: 'running', test: s1t1},
          {
            type: 'test',
            state: 'passed',
            test: s1t1,
            decorations: undefined,
            message: 'Duration: 0.000132 second(s)\n'
          },
          {type: 'test', state: 'running', test: s1t2},
          {
            type: 'test',
            state: 'failed',
            test: s1t2,
            decorations: [{line: 14, message: 'Expanded: false'}],
            message:
                'Duration: 0.000204 second(s)\n>>> s1t2(line: 13) REQUIRE (line: 15) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
          },
          {type: 'suite', state: 'completed', suite: suite1},
          {type: 'finished'},
        ];
        assert.deepStrictEqual(testStatesEvents, expected);

        await adapter.run([root.id]);
        assert.deepStrictEqual(testStatesEvents, [...expected, ...expected]);
      });

      it('cancels without any problem', async function() {
        adapter.cancel();
        assert.deepStrictEqual(testsEvents, []);
        assert.deepStrictEqual(testStatesEvents, []);

        adapter.cancel();
        assert.deepStrictEqual(testsEvents, []);
        assert.deepStrictEqual(testStatesEvents, []);

        await adapter.run([s1t1.id]);
        const expected = [
          {type: 'started', tests: [s1t1.id]},
          {type: 'suite', state: 'running', suite: suite1},
          {type: 'test', state: 'running', test: s1t1},
          {
            type: 'test',
            state: 'passed',
            test: s1t1,
            decorations: undefined,
            message: 'Duration: 0.000112 second(s)\n'
          },
          {type: 'suite', state: 'completed', suite: suite1},
          {type: 'finished'},
        ];
        assert.deepStrictEqual(testStatesEvents, expected);

        adapter.cancel();
        assert.deepStrictEqual(testsEvents, []);
        assert.deepStrictEqual(testStatesEvents, expected);
      });

      context('with config: defaultRngSeed=2', function() {
        before(() => {
          return updateConfig('defaultRngSeed', 2);
        })

        after(() => {
          return updateConfig('defaultRngSeed', undefined);
        })

        it('should run s1t1 with success', async function() {
          await adapter.run([s1t1.id]);
          const expected = [
            {type: 'started', tests: [s1t1.id]},
            {type: 'suite', state: 'running', suite: suite1},
            {type: 'test', state: 'running', test: s1t1},
            {
              type: 'test',
              state: 'passed',
              test: s1t1,
              decorations: undefined,
              message: 'Randomness seeded to: 2\nDuration: 0.000327 second(s)\n'
            },
            {type: 'suite', state: 'completed', suite: suite1},
            {type: 'finished'},
          ];
          assert.deepStrictEqual(testStatesEvents, expected);

          await adapter.run([s1t1.id]);
          assert.deepStrictEqual(testStatesEvents, [...expected, ...expected]);
        })
      })
    })

    context('executables=["execPath1", "${workspaceFolder}/execPath2"]', () => {
      before(() => {
        return updateConfig(
            'executables', ['execPath1', '${workspaceFolder}/execPath2']);
      });

      after(() => {
        return updateConfig('executables', undefined);
      });

      let suite1: TestSuiteInfo;
      let s1t1: TestInfo;
      let s1t2: TestInfo;
      let suite2: TestSuiteInfo;
      let s2t1: TestInfo;
      let s2t2: TestInfo;
      let s2t3: TestInfo;

      beforeEach(async function() {
        assert.deepStrictEqual(
            getConfig().get<any>('executables'),
            ['execPath1', '${workspaceFolder}/execPath2']);
        assert.equal(root.children.length, 2);

        assert.equal(root.children[0].type, 'suite');
        assert.equal(root.children[1].type, 'suite');
        suite1 = <TestSuiteInfo>root.children[0];
        suite2 = <TestSuiteInfo>root.children[1];
        if (suite2.label == 'execPath1') {
          suite1 = <TestSuiteInfo>root.children[1];
          suite2 = <TestSuiteInfo>root.children[0];
        }

        example1.suite1.assert(
            'execPath1', ['s1t1', 's1t2'], suite1, uniqueIdC);
        assert.equal(suite1.children.length, 2);
        assert.equal(suite1.children[0].type, 'test');
        s1t1 = <TestInfo>suite1.children[0];
        assert.equal(suite1.children[1].type, 'test');
        s1t2 = <TestInfo>suite1.children[1];

        example1.suite2.assert(
            path.join(workspaceFolderUri.path, 'execPath2'),
            ['s2t1', 's2t2 [.]', 's2t3'], suite2, uniqueIdC);
        assert.equal(suite2.children.length, 3);
        assert.equal(suite2.children[0].type, 'test');
        s2t1 = <TestInfo>suite2.children[0];
        assert.equal(suite2.children[1].type, 'test');
        s2t2 = <TestInfo>suite2.children[1];
        assert.equal(suite2.children[2].type, 'test');
        s2t3 = <TestInfo>suite2.children[2];
      });

      it('should run with not existing test id', async function() {
        await adapter.run(['not existing id']);

        assert.deepStrictEqual(testStatesEvents, [
          {type: 'started', tests: ['not existing id']},
          {type: 'finished'},
        ]);
      });

      it('should run s1t1 with success', async function() {
        await adapter.run([s1t1.id]);
        const expected = [
          {type: 'started', tests: [s1t1.id]},
          {type: 'suite', state: 'running', suite: suite1},
          {type: 'test', state: 'running', test: s1t1},
          {
            type: 'test',
            state: 'passed',
            test: s1t1,
            decorations: undefined,
            message: 'Duration: 0.000112 second(s)\n'
          },
          {type: 'suite', state: 'completed', suite: suite1},
          {type: 'finished'},
        ];
        assert.deepStrictEqual(testStatesEvents, expected);

        await adapter.run([s1t1.id]);
        assert.deepStrictEqual(testStatesEvents, [...expected, ...expected]);
      });

      it('should run suite1', async function() {
        await adapter.run([suite1.id]);
        const expected = [
          {type: 'started', tests: [suite1.id]},
          {type: 'suite', state: 'running', suite: suite1},
          {type: 'test', state: 'running', test: s1t1},
          {
            type: 'test',
            state: 'passed',
            test: s1t1,
            decorations: undefined,
            message: 'Duration: 0.000132 second(s)\n'
          },
          {type: 'test', state: 'running', test: s1t2},
          {
            type: 'test',
            state: 'failed',
            test: s1t2,
            decorations: [{line: 14, message: 'Expanded: false'}],
            message:
                'Duration: 0.000204 second(s)\n>>> s1t2(line: 13) REQUIRE (line: 15) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
          },
          {type: 'suite', state: 'completed', suite: suite1},
          {type: 'finished'},
        ];
        assert.deepStrictEqual(testStatesEvents, expected);

        await adapter.run([suite1.id]);
        assert.deepStrictEqual(testStatesEvents, [...expected, ...expected]);
      });

      it('should run all', async function() {
        await adapter.run([root.id]);

        const running = {type: 'started', tests: [root.id]};

        const s1running = {type: 'suite', state: 'running', suite: suite1};
        const s1finished = {type: 'suite', state: 'completed', suite: suite1};
        assert.ok(testStatesEvI(running) < testStatesEvI(s1running));
        assert.ok(testStatesEvI(s1running) < testStatesEvI(s1finished));

        const s2running = {type: 'suite', state: 'running', suite: suite2};
        const s2finished = {type: 'suite', state: 'completed', suite: suite2};
        assert.ok(testStatesEvI(running) < testStatesEvI(s1running));
        assert.ok(testStatesEvI(s2running) < testStatesEvI(s2finished));

        const s1t1running = {type: 'test', state: 'running', test: s1t1};
        assert.ok(testStatesEvI(s1running) < testStatesEvI(s1t1running));

        const s1t1finished = {
          type: 'test',
          state: 'passed',
          test: s1t1,
          decorations: undefined,
          message: 'Duration: 0.000132 second(s)\n'
        };
        assert.ok(testStatesEvI(s1t1running) < testStatesEvI(s1t1finished));
        assert.ok(testStatesEvI(s1t1finished) < testStatesEvI(s1finished));

        const s1t2running = {type: 'test', state: 'running', test: s1t2};
        assert.ok(testStatesEvI(s1running) < testStatesEvI(s1t2running));

        const s1t2finished = {
          type: 'test',
          state: 'failed',
          test: s1t2,
          decorations: [{line: 14, message: 'Expanded: false'}],
          message:
              'Duration: 0.000204 second(s)\n>>> s1t2(line: 13) REQUIRE (line: 15) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
        };
        assert.ok(testStatesEvI(s1t2running) < testStatesEvI(s1t2finished));
        assert.ok(testStatesEvI(s1t2finished) < testStatesEvI(s1finished));

        const s2t1running = {type: 'test', state: 'running', test: s2t1};
        assert.ok(testStatesEvI(s2running) < testStatesEvI(s2t1running));

        const s2t1finished = {
          type: 'test',
          state: 'passed',
          test: s2t1,
          decorations: undefined,
          message: 'Duration: 0.00037 second(s)\n'
        };
        assert.ok(testStatesEvI(s2t1running) < testStatesEvI(s2t1finished));
        assert.ok(testStatesEvI(s2t1finished) < testStatesEvI(s2finished));

        const s2t2running = {type: 'test', state: 'running', test: s2t2};
        assert.ok(testStatesEvI(s2running) < testStatesEvI(s2t2running));

        const s2t2finished = {type: 'test', state: 'skipped', test: s2t2};
        assert.ok(testStatesEvI(s2t2running) < testStatesEvI(s2t2finished));
        assert.ok(testStatesEvI(s2t2finished) < testStatesEvI(s2finished));

        const s2t3running = {type: 'test', state: 'running', test: s2t3};
        assert.ok(testStatesEvI(s2running) < testStatesEvI(s2t3running));

        const s2t3finished = {
          type: 'test',
          state: 'failed',
          test: s2t3,
          decorations: [{line: 20, message: 'Expanded: false'}],
          message:
              'Duration: 0.000178 second(s)\n>>> s2t3(line: 19) REQUIRE (line: 21) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
        };
        assert.ok(testStatesEvI(s2t3running) < testStatesEvI(s2t3finished));
        assert.ok(testStatesEvI(s2t3finished) < testStatesEvI(s2finished));

        const finished = {type: 'finished'};
        assert.ok(testStatesEvI(s1finished) < testStatesEvI(finished));
        assert.ok(testStatesEvI(s2finished) < testStatesEvI(finished));

        assert.equal(testStatesEvents.length, 16, inspect(testStatesEvents));
      })
    })

    context('executables=[{...}] and env={...}', function() {
      before(async () => {
        await updateConfig('executables', [{
                              name: '${dirname}: ${name} (${absDirname})',
                              path: '.',
                              regex: 'execPath(1|2)',
                              cwd: '${workspaceFolder}/cwd',
                              env: {
                                'C2LOCALTESTENV': 'c2localtestenv',
                                'C2OVERRIDETESTENV': 'c2overridetestenv-l',
                              }
                            }]);
        await updateConfig('defaultEnv',{
          'C2GLOBALTESTENV': 'c2globaltestenv',
          'C2OVERRIDETESTENV': 'c2overridetestenv-g',
        });
      });

      after(async () => {
        await updateConfig('executables', undefined);
        await updateConfig('defaultEnv', undefined);
      });

      let suite1: TestSuiteInfo;
      let s1t1: TestInfo;
      let s1t2: TestInfo;
      let suite2: TestSuiteInfo;
      let s2t1: TestInfo;
      let s2t2: TestInfo;
      let s2t3: TestInfo;

      beforeEach(async function() {
        assert.equal(root.children.length, 2);

        assert.equal(root.children[0].type, 'suite');
        assert.equal(root.children[1].type, 'suite');
        suite1 = <TestSuiteInfo>root.children[0];
        suite2 = <TestSuiteInfo>root.children[1];

        example1.suite1.assert(
            ': execPath1 (' + workspaceFolderUri.path + ')', ['s1t1', 's1t2'],
            suite1, uniqueIdC);
        assert.equal(suite1.children.length, 2);
        assert.equal(suite1.children[0].type, 'test');
        s1t1 = <TestInfo>suite1.children[0];
        assert.equal(suite1.children[1].type, 'test');
        s1t2 = <TestInfo>suite1.children[1];

        example1.suite2.assert(
            ': execPath2 (' + workspaceFolderUri.path + ')',
            ['s2t1', 's2t2 [.]', 's2t3'], suite2, uniqueIdC);
        assert.equal(suite2.children.length, 3);
        assert.equal(suite2.children[0].type, 'test');
        s2t1 = <TestInfo>suite2.children[0];
        assert.equal(suite2.children[1].type, 'test');
        s2t2 = <TestInfo>suite2.children[1];
        assert.equal(suite2.children[2].type, 'test');
        s2t3 = <TestInfo>suite2.children[2];
      })

      it('should run all', async function() {
        await adapter.run([root.id]);

        const running = {type: 'started', tests: [root.id]};

        const s1running = {type: 'suite', state: 'running', suite: suite1};
        const s1finished = {type: 'suite', state: 'completed', suite: suite1};
        assert.ok(testStatesEvI(running) < testStatesEvI(s1running));
        assert.ok(testStatesEvI(s1running) < testStatesEvI(s1finished));

        const s2running = {type: 'suite', state: 'running', suite: suite2};
        const s2finished = {type: 'suite', state: 'completed', suite: suite2};
        assert.ok(testStatesEvI(running) < testStatesEvI(s1running));
        assert.ok(testStatesEvI(s2running) < testStatesEvI(s2finished));

        const s1t1running = {type: 'test', state: 'running', test: s1t1};
        assert.ok(testStatesEvI(s1running) < testStatesEvI(s1t1running));

        const s1t1finished = {
          type: 'test',
          state: 'passed',
          test: s1t1,
          decorations: undefined,
          message: 'Duration: 0.000132 second(s)\n'
        };
        assert.ok(testStatesEvI(s1t1running) < testStatesEvI(s1t1finished));
        assert.ok(testStatesEvI(s1t1finished) < testStatesEvI(s1finished));

        const s1t2running = {type: 'test', state: 'running', test: s1t2};
        assert.ok(testStatesEvI(s1running) < testStatesEvI(s1t2running));

        const s1t2finished = {
          type: 'test',
          state: 'failed',
          test: s1t2,
          decorations: [{line: 14, message: 'Expanded: false'}],
          message:
              'Duration: 0.000204 second(s)\n>>> s1t2(line: 13) REQUIRE (line: 15) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
        };
        assert.ok(testStatesEvI(s1t2running) < testStatesEvI(s1t2finished));
        assert.ok(testStatesEvI(s1t2finished) < testStatesEvI(s1finished));

        const s2t1running = {type: 'test', state: 'running', test: s2t1};
        assert.ok(testStatesEvI(s2running) < testStatesEvI(s2t1running));

        const s2t1finished = {
          type: 'test',
          state: 'passed',
          test: s2t1,
          decorations: undefined,
          message: 'Duration: 0.00037 second(s)\n'
        };
        assert.ok(testStatesEvI(s2t1running) < testStatesEvI(s2t1finished));
        assert.ok(testStatesEvI(s2t1finished) < testStatesEvI(s2finished));

        const s2t2running = {type: 'test', state: 'running', test: s2t2};
        assert.ok(testStatesEvI(s2running) < testStatesEvI(s2t2running));

        const s2t2finished = {type: 'test', state: 'skipped', test: s2t2};
        assert.ok(testStatesEvI(s2t2running) < testStatesEvI(s2t2finished));
        assert.ok(testStatesEvI(s2t2finished) < testStatesEvI(s2finished));

        const s2t3running = {type: 'test', state: 'running', test: s2t3};
        assert.ok(testStatesEvI(s2running) < testStatesEvI(s2t3running));

        const s2t3finished = {
          type: 'test',
          state: 'failed',
          test: s2t3,
          decorations: [{line: 20, message: 'Expanded: false'}],
          message:
              'Duration: 0.000178 second(s)\n>>> s2t3(line: 19) REQUIRE (line: 21) \n  Original:\n    std::false_type::value\n  Expanded:\n    false\n<<<\n'
        };
        assert.ok(testStatesEvI(s2t3running) < testStatesEvI(s2t3finished));
        assert.ok(testStatesEvI(s2t3finished) < testStatesEvI(s2finished));

        const finished = {type: 'finished'};
        assert.ok(testStatesEvI(s1finished) < testStatesEvI(finished));
        assert.ok(testStatesEvI(s2finished) < testStatesEvI(finished));

        assert.equal(testStatesEvents.length, 16, inspect(testStatesEvents));
      })

      it('should get execution options', async function() {
        let called1 = false;
        spawnStub
            .withArgs(
                example1.suite1.execPath, sinon.match.any, sinon.match.any)
            .callsFake((p: string, args: string[], ops: any) => {
              assert.equal(ops.cwd, path.join(workspaceFolderUri.path, 'cwd'));
              assert.equal(ops.env.C2LOCALTESTENV, 'c2localtestenv');
              assert.ok(!ops.env.hasOwnProperty('C2GLOBALTESTENV'));
              assert.equal(ops.env.C2OVERRIDETESTENV, 'c2overridetestenv-l');
              called1 = true;
              return new ChildProcessStub(example1.suite1.outputs[2][1]);
            });
        await adapter.run([suite1.id]);
        assert.ok(called1);
        
        let called2 = false;
        spawnStub
            .withArgs(
                example1.suite2.execPath, sinon.match.any, sinon.match.any)
            .callsFake((p: string, args: string[], ops: any) => {
              assert.equal(ops.cwd, path.join(workspaceFolderUri.path, 'cwd'));
              assert.equal(ops.env.C2LOCALTESTENV, 'c2localtestenv');
              assert.ok(!ops.env.hasOwnProperty('C2GLOBALTESTENV'));
              assert.equal(ops.env.C2OVERRIDETESTENV, 'c2overridetestenv-l');
              called2 = true;
              return new ChildProcessStub(example1.suite2.outputs[2][1]);
            });
        await adapter.run([suite2.id]);
        assert.ok(called2);
      });
    })
  })
})

describe.skip('a', function() {
  this.timeout(99999);

  before(() => {
    debugger;
  });
  beforeEach(() => {
    debugger;
  });

  after(() => {
    debugger;
  });
  afterEach(() => {
    debugger;
  });

  it('a-it', () => {
    debugger;
  });

  describe('b', () => {
    before(() => {
      debugger;
    });
    beforeEach(() => {
      debugger;
    });

    after(() => {
      debugger;
    });
    afterEach(() => {
      debugger;
    });

    it('b-it1', () => {
      debugger;
    });

    it('b-it2', () => {
      debugger;
    });
  });
});
// fswatcher test aztan atiras vscode workspace watcherre
// bonyolultabb teszteset parsoleasa de az mehet kulon fileba c2testinfo
// mock getExecutables regex meg sima minden test
// ExecutableConfig
// execOptions
// writing xml
// re-load soame object
// deepstrictequal