import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

import { AbstractRunnable } from './AbstractRunnable';
import * as c2fs from './FSWrapper';
import {
  resolveVariables,
  resolveOSEnvironmentVariables,
  ResolveRulePair,
  createPythonIndexerForPathVariable,
  createPythonIndexerForStringVariable,
} from './Util';
import { RunnableSuiteFactory } from './RunnableSuiteFactory';
import { SharedVariables } from './SharedVariables';
import { GazeWrapper, VSCFSWatcherWrapper, FSWatcher } from './FSWatcher';
import { TestGrouping } from './TestGroupingInterface';
import { Suite } from './Suite';
import { RootSuite } from './RootSuite';
import { AbstractTest } from './AbstractTest';

export interface ExecutableConfigFrameworkSpecific {
  helpRegex?: string;
  prependTestRunningArgs?: string[];
  prependTestListingArgs?: string[];
  ignoreTestEnumerationStdErr?: boolean;
  testGrouping?: TestGrouping;
}

export class ExecutableConfig implements vscode.Disposable {
  public constructor(
    private readonly _shared: SharedVariables,
    private readonly _pattern: string,
    private readonly _name: string | undefined,
    private readonly _description: string | undefined,
    private readonly _cwd: string | undefined,
    private readonly _env: { [prop: string]: string } | undefined,
    private readonly _dependsOn: string[],
    private readonly _parallelizationLimit: number,
    private readonly _defaultCwd: string,
    private readonly _defaultEnv: { [prop: string]: string },
    private readonly _variableToValue: ResolveRulePair[],
    private readonly _catch2: ExecutableConfigFrameworkSpecific,
    private readonly _gtest: ExecutableConfigFrameworkSpecific,
    private readonly _doctest: ExecutableConfigFrameworkSpecific,
  ) {
    if ([_catch2, _gtest, _doctest].some(f => Object.keys(f).length > 0)) {
      _shared.log.info('TestExecutableInfoFrameworkSpecific', _catch2, _gtest, _doctest);
      _shared.log.infoMessageWithTags('TestExecutableInfoFrameworkSpecific', {});
    }
  }

  private _disposables: vscode.Disposable[] = [];

  private readonly _runnables: Map<string /*fsPath*/, AbstractRunnable> = new Map();

  private readonly _lastEventArrivedAt: Map<string /*fsPath*/, number /*Date*/> = new Map();

  public dispose(): void {
    this._disposables.forEach(d => d.dispose());
  }

  public cancel(): void {
    for (const r of this._runnables.values()) r.cancel();
  }

  public async load(rootSuite: RootSuite): Promise<void> {
    const pattern = this._patternProcessor(this._pattern);

    this._shared.log.info('pattern', this._pattern, this._shared.workspaceFolder.uri.fsPath, pattern);

    if (pattern.isAbsolute && pattern.isPartOfWs)
      this._shared.log.info('Absolute path is used for workspace directory. This is unnecessary, but it should work.');

    if (this._pattern.indexOf('\\') != -1)
      this._shared.log.info('Pattern contains backslash character. Try to avoid that.');

    let filePaths: string[] = [];

    let execWatcher: FSWatcher | undefined = undefined;
    try {
      if (pattern.isPartOfWs) {
        execWatcher = new VSCFSWatcherWrapper(this._shared.workspaceFolder, pattern.relativeToWsPosix);
      } else {
        execWatcher = new GazeWrapper([pattern.absPattern]);
      }

      filePaths = await execWatcher.watched();

      execWatcher.onError((err: Error) => {
        // eslint-disable-next-line
        if ((err as any).code == 'ENOENT') this._shared.log.info('watcher error', err);
        else this._shared.log.error('watcher error', err);
      });

      execWatcher.onAll(fsPath => {
        this._shared.log.info('watcher event:', fsPath);
        this._handleEverything(fsPath, rootSuite);
      });

      this._disposables.push(execWatcher);
    } catch (e) {
      execWatcher && execWatcher.dispose();
      filePaths.push(this._pattern);

      this._shared.log.exception(e, "Coudn't watch pattern");
    }

    const suiteCreationAndLoadingTasks: Promise<void>[] = [];

    for (let i = 0; i < filePaths.length; i++) {
      const file = filePaths[i];
      this._shared.log.info('Checking file for tests:', file);

      if (this._shouldIgnorePath(file)) continue;

      if (this._isDuplicate(file)) continue;

      suiteCreationAndLoadingTasks.push(
        c2fs.isNativeExecutableAsync(file).then(
          () => {
            return this._createSuiteByUri(file, rootSuite)
              .create(false)
              .then(
                (suite: AbstractRunnable) => {
                  return suite.reloadTests(this._shared.taskPool).then(
                    () => {
                      this._runnables.set(file, suite);
                    },
                    (reason: Error) => {
                      this._shared.log.warn("Couldn't load executable:", reason, suite);
                    },
                  );
                },
                (reason: Error) => {
                  this._shared.log.localDebug('Not a test executable:', file, 'reason:', reason);
                },
              );
          },
          (reason: Error) => {
            this._shared.log.localDebug('Not an executable:', file, reason);
          },
        ),
      );
    }

    await Promise.all(suiteCreationAndLoadingTasks);

    if (this._dependsOn.length > 0) {
      try {
        // gaze can handle more patterns at once
        const absPatterns: string[] = [];

        for (const pattern of this._dependsOn) {
          const p = this._patternProcessor(pattern);
          if (p.isPartOfWs) {
            const w = new VSCFSWatcherWrapper(this._shared.workspaceFolder, p.relativeToWsPosix);
            this._disposables.push(w);

            w.onError((e: Error): void => this._shared.log.error('dependsOn watcher:', e, p));

            w.onAll((fsPath: string): void => {
              this._shared.log.info('dependsOn watcher event:', fsPath);
              const tests: AbstractTest[] = [];
              for (const runnable of this._runnables) tests.push(...runnable[1].tests);
              this._shared.retire.fire(tests);
            });
          } else {
            absPatterns.push(p.absPattern);
          }
        }

        if (absPatterns.length > 0) {
          const w = new GazeWrapper(absPatterns);
          this._disposables.push(w);

          w.onError((e: Error): void => this._shared.log.error('dependsOn watcher:', e, absPatterns));

          w.onAll((fsPath: string): void => {
            this._shared.log.info('dependsOn watcher event:', fsPath);
            const tests: AbstractTest[] = [];
            for (const runnable of this._runnables) tests.push(...runnable[1].tests);
            this._shared.retire.fire(tests);
          });
        }
      } catch (e) {
        this._shared.log.error('dependsOn error:', e);
      }
    }
  }

  private _patternProcessor(
    pattern: string,
  ): {
    isAbsolute: boolean;
    absPattern: string;
    relativeToWs: string;
    isPartOfWs: boolean;
    relativeToWsPosix: string;
  } {
    pattern = resolveOSEnvironmentVariables(pattern, false);
    const isAbsolute = path.isAbsolute(pattern);
    const absPattern = isAbsolute
      ? vscode.Uri.file(path.normalize(pattern)).fsPath
      : vscode.Uri.file(path.join(this._shared.workspaceFolder.uri.fsPath, pattern)).fsPath;
    const relativeToWs = path.relative(this._shared.workspaceFolder.uri.fsPath, absPattern);

    return {
      isAbsolute,
      absPattern,
      relativeToWs,
      isPartOfWs: !relativeToWs.startsWith('..'),
      relativeToWsPosix: relativeToWs.split('\\').join('/'),
    };
  }

  private _createSuiteByUri(filePath: string, rootSuite: Suite): RunnableSuiteFactory {
    const relPath = path.relative(this._shared.workspaceFolder.uri.fsPath, filePath);

    let varToValue: ResolveRulePair[] = [];

    const subPath = createPythonIndexerForPathVariable;

    const subFilename = (valName: string, filename: string): [RegExp, (m: RegExpMatchArray) => string] =>
      createPythonIndexerForStringVariable(valName, filename, '.', '.');

    try {
      const filename = path.basename(filePath);
      const extFilename = path.extname(filename);
      const baseFilename = path.basename(filename, extFilename);

      varToValue = [
        ...this._variableToValue,
        subPath('absPath', filePath),
        subPath('relPath', relPath),
        subPath('absDirpath', path.dirname(filePath)),
        subPath('relDirpath', path.dirname(relPath)),
        subFilename('filename', filename),
        ['${extFilename}', extFilename],
        ['${baseFilename}', baseFilename],
      ];
    } catch (e) {
      this._shared.log.exception(e);
    }

    const variableRe = /\$\{[^ ]*\}/;

    let resolvedCwd = '.';
    try {
      if (this._cwd) resolvedCwd = resolveVariables(this._cwd, varToValue);
      else resolvedCwd = resolveVariables(this._defaultCwd, varToValue);

      resolvedCwd = resolveOSEnvironmentVariables(resolvedCwd, false);

      if (resolvedCwd.match(variableRe)) this._shared.log.warn('Possibly unresolved variable', resolvedCwd);

      resolvedCwd = path.resolve(this._shared.workspaceFolder.uri.fsPath, resolvedCwd);

      varToValue.push(subPath('cwd', resolvedCwd));
    } catch (e) {
      this._shared.log.error('resolvedCwd', e);
    }

    let resolvedEnv: { [prop: string]: string } = {};
    try {
      Object.assign(resolvedEnv, this._defaultEnv);

      if (this._env) Object.assign(resolvedEnv, this._env);

      resolvedEnv = resolveVariables(resolvedEnv, varToValue);
      resolvedEnv = resolveOSEnvironmentVariables(resolvedEnv, true);
    } catch (e) {
      this._shared.log.error('resolvedEnv', e);
    }

    return new RunnableSuiteFactory(
      this._shared,
      this._name,
      this._description,
      rootSuite,
      filePath,
      {
        cwd: resolvedCwd,
        env: Object.assign({}, process.env, resolvedEnv),
      },
      varToValue,
      this._catch2,
      this._gtest,
      this._doctest,
      this._parallelizationLimit,
    );
  }

  private _handleEverything(filePath: string, rootSuite: RootSuite): void {
    const isRunning = this._lastEventArrivedAt.get(filePath) !== undefined;
    if (isRunning) return;

    this._lastEventArrivedAt.set(filePath, Date.now());

    const runnable = this._runnables.get(filePath);

    if (runnable !== undefined) {
      this._recursiveHandleEverything(runnable, false, 128);
    } else {
      if (this._shouldIgnorePath(filePath)) return;

      this._shared.log.info('possibly new suite: ' + filePath);
      this._createSuiteByUri(filePath, rootSuite)
        .create(true)
        .then(
          (s: AbstractRunnable) => this._recursiveHandleEverything(s, false, 128),
          (reason: Error) => this._shared.log.info("couldn't add: " + filePath, 'reson:', reason),
        );
    }
  }

  private _recursiveHandleEverything(
    runnable: AbstractRunnable,
    isFileExistsAndExecutable: boolean,
    delay: number,
  ): Promise<void> {
    const filePath = runnable.properties.path;
    const lastEventArrivedAt = this._lastEventArrivedAt.get(filePath);
    if (lastEventArrivedAt === undefined) {
      this._shared.log.error('assert');
      debugger;
      return Promise.resolve();
    } else if (Date.now() - lastEventArrivedAt > this._shared.execWatchTimeout) {
      this._shared.log.info('refresh timeout:', filePath);
      this._lastEventArrivedAt.delete(filePath);
      const foundRunnable = this._runnables.get(filePath);
      if (foundRunnable) {
        return new Promise<void>(resolve => {
          this._shared.loadWithTaskEmitter.fire(() => {
            foundRunnable.removeTests();
            this._runnables.delete(filePath);
            resolve();
          });
        });
      } else {
        return Promise.resolve();
      }
    } else if (isFileExistsAndExecutable) {
      return new Promise<void>((resolve, reject) => {
        this._shared.loadWithTaskEmitter.fire(() => {
          return runnable
            .reloadTests(this._shared.taskPool)
            .then(() => {
              this._runnables.set(filePath, runnable); // it might be set already but we don't care
              this._lastEventArrivedAt.delete(filePath);
              this._shared.retire.fire(runnable.tests);
            })
            .then(resolve, reject);
        });
      }).catch((reason: Error & { code: undefined | number }) => {
        if (reason.code === undefined) {
          this._shared.log.localDebug('reason', reason);
          this._shared.log.localDebug('filePath', filePath);
          this._shared.log.localDebug('suite', runnable);
          this._shared.log.warn('problem under reloading', reason);
        }
        return this._recursiveHandleEverything(runnable, false, Math.min(delay * 2, 2000));
      });
    } else {
      return promisify(setTimeout)(Math.min(delay * 2, 2000)).then(() => {
        return c2fs
          .isNativeExecutableAsync(filePath)
          .then(
            () => true,
            () => false,
          )
          .then(isExec => this._recursiveHandleEverything(runnable, isExec, Math.min(delay * 2, 2000)));
      });
    }
  }

  private _shouldIgnorePath(filePath: string): boolean {
    if (!this._pattern.match(/(\/|\\)_deps(\/|\\)/) && filePath.indexOf('/_deps/') !== -1) {
      // cmake fetches the dependencies here. we dont care about it 🤞
      this._shared.log.info('skipping because it is under "/_deps/"', filePath);
      return true;
    } else {
      return false;
    }
  }

  private _isDuplicate(filePath: string): boolean {
    return this._runnables.has(filePath);
  }
}