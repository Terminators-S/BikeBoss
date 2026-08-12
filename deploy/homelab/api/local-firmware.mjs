import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export class LocalFirmwareBucket {
  constructor(rootDirectory) {
    this.rootDirectory = resolve(rootDirectory);
  }

  resolveKey(objectKey) {
    const normalizedKey = String(objectKey ?? '').replaceAll('\\', '/');
    if (!normalizedKey || normalizedKey.startsWith('/') || normalizedKey.split('/').includes('..')) {
      return null;
    }
    const objectPath = resolve(this.rootDirectory, normalizedKey);
    if (objectPath !== this.rootDirectory && !objectPath.startsWith(`${this.rootDirectory}${sep}`)) {
      return null;
    }
    return objectPath;
  }

  async get(objectKey) {
    const objectPath = this.resolveKey(objectKey);
    if (!objectPath) return null;
    try {
      const details = await stat(objectPath);
      if (!details.isFile()) return null;
      return {
        size: details.size,
        body: await readFile(objectPath),
        writeHttpMetadata(headers) {
          headers.set('Content-Type', 'application/octet-stream');
        },
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
}
