import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { D1SqliteDatabase } from './d1-sqlite.mjs';
import { LocalFirmwareBucket } from './local-firmware.mjs';

test('D1 adapter supports prepare, bind, first, all, run and atomic batch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bikeboss-d1-'));
  const database = new D1SqliteDatabase(join(root, 'test.sqlite'));
  t.after(() => database.close());
  await database.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT UNIQUE)');

  const inserted = await database.prepare('INSERT INTO sample (value) VALUES (?)').bind('one').run();
  assert.equal(inserted.meta.last_row_id, 1);
  assert.equal((await database.prepare('SELECT value FROM sample WHERE id = ?').bind(1).first()).value, 'one');

  await database.batch([
    database.prepare('INSERT INTO sample (value) VALUES (?)').bind('two'),
    database.prepare('INSERT INTO sample (value) VALUES (?)').bind('three'),
  ]);
  const rows = await database.prepare('SELECT value FROM sample ORDER BY id').all();
  assert.deepEqual(rows.results.map((row) => row.value), ['one', 'two', 'three']);

  await assert.rejects(database.batch([
    database.prepare('INSERT INTO sample (value) VALUES (?)').bind('four'),
    database.prepare('INSERT INTO sample (value) VALUES (?)').bind('one'),
  ]));
  assert.equal((await database.prepare('SELECT COUNT(*) AS total FROM sample').first()).total, 3);
});

test('local firmware bucket reads contained objects and blocks traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bikeboss-firmware-'));
  await mkdir(join(root, 'releases'));
  await writeFile(join(root, 'releases', 'firmware.bin'), Buffer.from('signed-firmware'));
  const bucket = new LocalFirmwareBucket(root);

  const object = await bucket.get('releases/firmware.bin');
  assert.equal(object.size, 15);
  assert.equal(object.body.toString(), 'signed-firmware');
  assert.equal(await bucket.get('../outside.bin'), null);
  assert.equal(await bucket.get('/etc/passwd'), null);
});

test('D1 import accepts child rows before parent schema and validates afterward', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bikeboss-import-'));
  const importPath = join(root, 'import.sql');
  await writeFile(importPath, `
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    INSERT INTO child (id, parent_id) VALUES (1, 7);
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    INSERT INTO parent (id) VALUES (7);
  `);
  const database = new D1SqliteDatabase(join(root, 'imported.sqlite'), { importPath });
  t.after(() => database.close());
  assert.equal((await database.prepare('SELECT parent_id FROM child').first()).parent_id, 7);
});
