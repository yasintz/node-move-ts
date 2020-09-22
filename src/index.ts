import { ReferenceIndexer, isInDir } from './index/referenceindexer';
import * as fs from 'fs-extra-promise';
import * as path from 'path';

export enum MoveError {
  TARGED_ALREADY_EXIST,
}

function makeid(length: number) {
  var result = '';
  var characters = 'abcdefghijklmnopqrstuvwxyz';
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}
async function moveFile(
  importer: ReferenceIndexer,
  sourcePath: string,
  targetPath: string
) {
  await fs.ensureDirAsync(path.dirname(targetPath));

  await importer.updateImports(sourcePath, targetPath);

  await fs.renameAsync(sourcePath, targetPath);

  await importer.updateMovedFile(sourcePath, targetPath);
}

async function moveFolder(
  importer: ReferenceIndexer,
  sourcePath: string,
  targetPath: string
) {
  if (isInDir(sourcePath, targetPath)) {
    const parentDir = path.dirname(sourcePath);
    let newPath = path.join(parentDir, makeid(9));
    while (fs.existsSync(newPath)) {
      newPath = path.join(parentDir, makeid(9));
    }
    await moveFolder(importer, sourcePath, newPath);
    await moveFolder(importer, newPath, targetPath);
    return;
  }

  const files = await fs.readdirAsync(sourcePath);

  for (let index = 0; index < files.length; index++) {
    const file = path.join(sourcePath, files[index]);
    const baseName = path.basename(file);
    const newTarget = path.join(targetPath, baseName);
    await moveInternal(importer, file, newTarget);
  }
  await fs.removeAsync(sourcePath);
}

async function moveInternal(
  importer: ReferenceIndexer,
  source: string,
  target: string
) {
  const sourcePath = path.resolve(source);
  const targetPath = path.resolve(target);

  if (sourcePath === targetPath) {
    return;
  }

  const exists = fs.existsSync(targetPath);

  if (exists) {
    throw MoveError.TARGED_ALREADY_EXIST;
  }

  const isDir = fs.statSync(sourcePath).isDirectory();
  if (isDir) {
    return moveFolder(importer, sourcePath, targetPath);
  }

  return moveFile(importer, sourcePath, targetPath);
}

async function move(root: string, source: string, target: string) {
  const importer = new ReferenceIndexer(root);
  await importer.init();

  return moveInternal(
    importer,
    path.join(root, source),
    path.join(root, target)
  );
}
export default move;
