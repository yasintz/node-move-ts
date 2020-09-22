import * as fs from 'fs-extra-promise';
import * as path from 'path';

const ALLOWED_EXTENSION = ['.ts', '.tsx'];
const EXCLUDED_FOLDERS = ['node_modules', '.git'];

export async function findAllTSFiles(dir: string, tsFiles: string[] = []) {
  const files = await fs.readdirAsync(dir);
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const fullPath = path.join(dir, file);
    const isDir = (await fs.lstatAsync(fullPath)).isDirectory();
    if (isDir) {
      const isExcluded = EXCLUDED_FOLDERS.map((name) => file === name).reduce(
        (acc, cur) => acc || cur,
        false
      );
      if (!isExcluded) {
        await findAllTSFiles(fullPath, tsFiles);
      }
    } else {
      const ext = path.extname(fullPath);
      if (ALLOWED_EXTENSION.indexOf(ext) > -1) {
        tsFiles.push(fullPath);
      }
    }
  }

  return tsFiles;
}
