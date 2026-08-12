import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

function bindValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function numeric(value) {
  if (typeof value !== 'bigint') return value;
  const converted = Number(value);
  return Number.isSafeInteger(converted) ? converted : value.toString();
}

function resultMeta(startedAt, result = {}) {
  return {
    changes: numeric(result.changes ?? 0),
    duration: performance.now() - startedAt,
    last_row_id: numeric(result.lastInsertRowid ?? 0),
  };
}

export class D1PreparedStatement {
  constructor(database, query, values = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new D1PreparedStatement(this.database, this.query, values.map(bindValue));
  }

  _statement() {
    return this.database.sqlite.prepare(this.query);
  }

  async first(columnName) {
    const row = this._statement().get(...this.values);
    if (!row) return null;
    return columnName ? (row[columnName] ?? null) : row;
  }

  async all() {
    const startedAt = performance.now();
    const results = this._statement().all(...this.values);
    return {
      success: true,
      results,
      meta: resultMeta(startedAt),
    };
  }

  async run() {
    const startedAt = performance.now();
    const result = this._statement().run(...this.values);
    return {
      success: true,
      results: [],
      meta: resultMeta(startedAt, result),
    };
  }

  _batchExecute() {
    const startedAt = performance.now();
    const statement = this._statement();
    if (statement.columns().length > 0) {
      return {
        success: true,
        results: statement.all(...this.values),
        meta: resultMeta(startedAt),
      };
    }
    const result = statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: resultMeta(startedAt, result),
    };
  }
}

export class D1SqliteDatabase {
  constructor(databasePath, { schemaPath, importPath } = {}) {
    this.databasePath = resolve(databasePath);
    const isNewDatabase = !existsSync(this.databasePath);
    this.sqlite = new DatabaseSync(this.databasePath);
    this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

    if (isNewDatabase && importPath && existsSync(importPath)) {
      // D1 exports can insert a child table before its referenced parent table
      // appears later in the same file. Import atomically with FK enforcement
      // disabled, then reject the database if the completed snapshot has any
      // referential-integrity violations.
      const importSql = readFileSync(importPath, 'utf8');
      this.sqlite.exec('PRAGMA foreign_keys = OFF');
      try {
        this.sqlite.exec(`BEGIN IMMEDIATE;\n${importSql}\nCOMMIT;`);
      } catch (error) {
        try { this.sqlite.exec('ROLLBACK'); } catch { /* transaction already closed */ }
        throw error;
      }
      this.sqlite.exec('PRAGMA foreign_keys = ON');
      const violation = this.sqlite.prepare('PRAGMA foreign_key_check').get();
      if (violation) throw new Error(`Imported D1 snapshot has a foreign-key violation in ${violation.table}`);
      renameSync(importPath, `${importPath}.applied`);
    }
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    if (schemaPath) this.sqlite.exec(readFileSync(schemaPath, 'utf8'));
  }

  prepare(query) {
    return new D1PreparedStatement(this, query);
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement._batchExecute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(query) {
    const startedAt = performance.now();
    this.sqlite.exec(query);
    return { count: 0, duration: performance.now() - startedAt };
  }

  async backupTo(targetPath) {
    const resolvedTarget = resolve(targetPath);
    await mkdir(dirname(resolvedTarget), { recursive: true });
    return backup(this.sqlite, resolvedTarget);
  }

  close() {
    this.sqlite.close();
  }
}
