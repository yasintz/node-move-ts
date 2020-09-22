import * as fs from 'fs-extra-promise';
import * as path from 'path';
import ts from 'typescript';
import { findAllTSFiles } from '../utils';

import { isPathToAnotherDir, ReferenceIndex } from './referenceindex';

const BATCH_SIZE = 50;

type Replacement = [string, string];
type Thenable<T> = Promise<T>;

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

interface Reference {
  specifier: string;
  location: { start: number; end: number };
}

export function isInDir(dir: string, p: string) {
  const relative = path.relative(dir, p);
  return !isPathToAnotherDir(relative);
}

export function asUnix(fsPath: string) {
  return fsPath.replace(/\\/g, '/');
}

export class ReferenceIndexer {
  private tsconfigs: { [key: string]: any } = {};
  public index: ReferenceIndex = new ReferenceIndex();

  private packageNames: { [key: string]: string } = {};

  private extensions: string[] = ['.ts', '.tsx'];
  private isInitialized: boolean = false;

  constructor(readonly rootPath: string) {}

  public init = async () => {
    if (this.isInitialized) {
      return;
    }

    this.index = new ReferenceIndex();

    await this.readPackageNames();
    await this.scanAll();
    this.isInitialized = true;
  };

  private readPackageNames(): Thenable<any> {
    this.packageNames = {};
    this.tsconfigs = {};

    let seenPackageNames: { [key: string]: boolean } = {};
    const packageJsonFile = path.join(this.rootPath, 'package.json');
    const tsConfigFile = path.join(this.rootPath, 'tsconfig.json');

    const packagePromise = fs
      .readFileAsync(packageJsonFile, 'utf-8')
      .then(content => {
        try {
          let json = JSON.parse(content);
          if (json.name) {
            if (seenPackageNames[json.name]) {
              delete this.packageNames[json.name];
              return;
            }
            seenPackageNames[json.name] = true;
            this.packageNames[json.name] = path.dirname(packageJsonFile);
          }
        } catch (e) {}
      });
    const tsConfigPromise = fs
      .readFileAsync(tsConfigFile, 'utf-8')
      .then(content => {
        try {
          const config = ts.parseConfigFileTextToJson(tsConfigFile, content);
          if (config.config) {
            this.tsconfigs[tsConfigFile] = config.config;
          }
        } catch (e) {}
      });

    return Promise.all([packagePromise, tsConfigPromise]);
  }

  private scanAll = async () => {
    this.index = new ReferenceIndex();
    const files = await findAllTSFiles(this.rootPath);
    await this.processWorkspaceFiles(files, false);
  };

  private getEdits(
    path: string,
    text: string,
    replacements: Replacement[],
    fromPath?: string
  ): Edit[] {
    const edits: Edit[] = [];
    const relativeReferences = this.getRelativeReferences(
      text,
      fromPath || path
    );
    replacements.forEach(replacement => {
      const before = replacement[0];
      const after = replacement[1];
      if (before == after) {
        return;
      }
      const beforeReference = this.resolveRelativeReference(
        fromPath || path,
        before
      );
      const beforeReplacements = relativeReferences.filter(ref => {
        return (
          this.resolveRelativeReference(fromPath || path, ref.specifier) ==
          beforeReference
        );
      });
      beforeReplacements.forEach(beforeReplacement => {
        const edit = {
          start: beforeReplacement.location.start + 1,
          end: beforeReplacement.location.end - 1,
          replacement: after,
        };
        edits.push(edit);
      });
    });

    return edits;
  }

  private applyEdits(text: string, edits: Edit[]): string {
    const replaceBetween = (
      str: string,
      start: number,
      end: number,
      replacement: string
    ): string => {
      return str.substr(0, start) + replacement + str.substr(end);
    };

    edits.sort((a, b) => {
      return a.start - b.start;
    });

    let editOffset = 0;
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      text = replaceBetween(
        text,
        edit.start + editOffset,
        edit.end + editOffset,
        edit.replacement
      );
      editOffset += edit.replacement.length - (edit.end - edit.start);
    }
    return text;
  }

  private replaceReferences(
    filePath: string,
    getReplacements: (text: string) => Replacement[],
    fromPath?: string
  ): Thenable<any> {
    return fs.readFileAsync(filePath, 'utf8').then(text => {
      const replacements = getReplacements(text);
      const edits = this.getEdits(filePath, text, replacements, fromPath);
      if (edits.length == 0) {
        return Promise.resolve();
      }

      const newText = this.applyEdits(text, edits);

      return fs.writeFileAsync(filePath, newText, 'utf-8').then(() => {
        this.processFile(newText, filePath, true);
      });
    });
  }

  public updateMovedFile(from: string, to: string): Thenable<any> {
    return this.replaceReferences(
      to,
      (text: string): Replacement[] => {
        const references = Array.from(
          new Set(this.getRelativeImportSpecifiers(text, from))
        );

        const replacements = references.map((reference): [string, string] => {
          const absReference = this.resolveRelativeReference(from, reference);
          const newReference = this.getRelativePath(to, absReference);
          return [reference, newReference];
        });
        return replacements;
      },
      from
    ).then(() => {
      this.index.deleteByPath(from);
    });
  }

  public removeExtension(filePath: string): string {
    let ext = path.extname(filePath);
    if (ext == '.ts' && filePath.endsWith('.d.ts')) {
      ext = '.d.ts';
    }
    if (this.extensions.indexOf(ext) >= 0) {
      return filePath.slice(0, -ext.length);
    }
    return filePath;
  }

  public removeIndexSuffix(filePath: string): string {
    const indexSuffix = '/index';
    if (filePath.endsWith(indexSuffix)) {
      return filePath.slice(0, -indexSuffix.length);
    }
    return filePath;
  }

  private processWorkspaceFiles(
    files: string[],
    deleteByFile: boolean = false
  ): Promise<any> {
    files = files.filter(f => {
      return (
        f.indexOf('typings') === -1 &&
        f.indexOf('node_modules') === -1 &&
        f.indexOf('jspm_packages') === -1
      );
    });

    return new Promise(resolve => {
      let index = 0;

      const next = () => {
        for (let i = 0; i < BATCH_SIZE && index < files.length; i++) {
          const file = files[index++];
          try {
            const data = fs.readFileSync(file, 'utf8');
            this.processFile(data, file, deleteByFile);
          } catch (e) {
            console.log('Failed to load file', e);
          }
        }

        if (index < files.length) {
          setTimeout(next, 0);
        } else {
          resolve();
        }
      };
      next();
    });
  }

  private doesFileExist(filePath: string) {
    if (fs.existsSync(filePath)) {
      return true;
    }
    for (let i = 0; i < this.extensions.length; i++) {
      if (fs.existsSync(filePath + this.extensions[i])) {
        return true;
      }
    }
    return false;
  }

  private getRelativePath(from: string, to: string): string {
    const configInfo = this.getTsConfig(from);
    if (configInfo) {
      const config = configInfo.config;
      const configPath = configInfo.configPath;
      if (
        config.compilerOptions &&
        config.compilerOptions.paths &&
        config.compilerOptions.baseUrl
      ) {
        const baseUrl = path.resolve(
          path.dirname(configPath),
          config.compilerOptions.baseUrl
        );
        for (let p in config.compilerOptions.paths) {
          const paths = config.compilerOptions.paths[p];
          for (let i = 0; i < paths.length; i++) {
            const mapped = paths[i].slice(0, -1);
            const mappedDir = path.resolve(baseUrl, mapped);
            if (isInDir(mappedDir, to)) {
              return asUnix(p.slice(0, -1) + path.relative(mappedDir, to));
            }
          }
        }
      }
    }
    for (let packageName in this.packageNames) {
      const packagePath = this.packageNames[packageName];
      if (isInDir(packagePath, to) && !isInDir(packagePath, from)) {
        return asUnix(path.join(packageName, path.relative(packagePath, to)));
      }
    }

    let relative = path.relative(path.dirname(from), to);
    if (!relative.startsWith('.')) {
      relative = './' + relative;
    }
    return asUnix(relative);
  }

  private resolveRelativeReference(fsPath: string, reference: string): string {
    if (reference.startsWith('.')) {
      return path.resolve(path.dirname(fsPath), reference);
    } else {
      const configInfo = this.getTsConfig(fsPath);
      if (configInfo) {
        const config = configInfo.config;
        const configPath = configInfo.configPath;

        if (
          config.compilerOptions &&
          config.compilerOptions.paths &&
          config.compilerOptions.baseUrl
        ) {
          const baseUrl = path.resolve(
            path.dirname(configPath),
            config.compilerOptions.baseUrl
          );
          for (let p in config.compilerOptions.paths) {
            if (p.endsWith('*') && reference.startsWith(p.slice(0, -1))) {
              const paths = config.compilerOptions.paths[p];
              for (let i = 0; i < paths.length; i++) {
                const mapped = paths[i].slice(0, -1);
                const mappedDir = path.resolve(baseUrl, mapped);
                const potential = path.join(
                  mappedDir,
                  reference.substr(p.slice(0, -1).length)
                );
                if (this.doesFileExist(potential)) {
                  return potential;
                }
              }
              if (config.compilerOptions.paths[p].length == 1) {
                const mapped = config.compilerOptions.paths[p][0].slice(0, -1);
                const mappedDir = path.resolve(
                  path.dirname(configPath),
                  mapped
                );
                return path.join(
                  mappedDir,
                  reference.substr(p.slice(0, -1).length)
                );
              }
            }
          }
        }
      }
      for (let packageName in this.packageNames) {
        if (reference.startsWith(packageName + '/')) {
          return path.resolve(
            this.packageNames[packageName],
            reference.substr(packageName.length + 1)
          );
        }
      }
    }
    return '';
  }

  private getTsConfig(filePath: string): any {
    let prevDir = filePath;
    let dir = path.dirname(filePath);
    while (dir != prevDir) {
      const tsConfigPaths = [
        path.join(dir, 'tsconfig.json'),
        path.join(dir, 'tsconfig.build.json'),
      ];
      const tsConfigPath = tsConfigPaths.find(p =>
        this.tsconfigs.hasOwnProperty(p)
      );

      if (tsConfigPath) {
        return {
          config: this.tsconfigs[tsConfigPath],
          configPath: tsConfigPath,
        };
      }
      prevDir = dir;
      dir = path.dirname(dir);
    }
    return null;
  }

  private getRelativeImportSpecifiers(
    data: string,
    filePath: string
  ): string[] {
    return this.getRelativeReferences(data, filePath).map(ref => ref.specifier);
  }

  private getReferences(fileName: string, data: string): Reference[] {
    const result: Reference[] = [];
    const file = ts.createSourceFile(fileName, data, ts.ScriptTarget.Latest);

    file.statements.forEach((node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          result.push({
            specifier: node.moduleSpecifier.text,
            location: {
              start: node.moduleSpecifier.getStart(file),
              end: node.moduleSpecifier.getEnd(),
            },
          });
        }
      }
    });

    return result;
  }

  private getRelativeReferences(data: string, filePath: string): Reference[] {
    const references: Set<string> = new Set();

    const imports = this.getReferences(filePath, data);
    for (let i = 0; i < imports.length; i++) {
      const importModule = imports[i].specifier;
      if (importModule.startsWith('.')) {
        references.add(importModule);
      } else {
        const resolved = this.resolveRelativeReference(filePath, importModule);
        if (resolved.length > 0) {
          references.add(importModule);
        }
      }
    }
    return imports.filter(i => references.has(i.specifier));
  }

  private processFile(
    data: string,
    filePath: string,
    deleteByFile: boolean = false
  ) {
    if (deleteByFile) {
      this.index.deleteByPath(filePath);
    }

    const fsPath = this.removeExtension(filePath);

    const references = this.getRelativeImportSpecifiers(data, fsPath);

    for (let i = 0; i < references.length; i++) {
      let referenced = this.resolveRelativeReference(filePath, references[i]);
      for (let j = 0; j < this.extensions.length; j++) {
        const ext = this.extensions[j];
        if (!referenced.endsWith(ext) && fs.existsSync(referenced + ext)) {
          referenced += ext;
        }
      }
      this.index.addReference(referenced, filePath);
    }
  }

  public updateImports(from: string, to: string): Promise<any> {
    const affectedFiles = this.index.getReferences(from);
    const promises = affectedFiles.map(filePath => {
      return this.replaceReferences(filePath.path, (): Replacement[] => {
        let relative = this.getRelativePath(filePath.path, from);
        relative = this.removeExtension(relative);

        let newRelative = this.getRelativePath(filePath.path, to);
        newRelative = this.removeExtension(newRelative);
        newRelative = this.removeIndexSuffix(newRelative);

        return [[relative, newRelative]];
      });
    });
    return Promise.all(promises).catch(e => {
      console.log(e);
    });
  }
}
