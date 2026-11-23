// D1 互換の薄いラッパー（node:sqlite）。ローカル確認とテスト用
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  _p() { return this.db.prepare(this.sql); }
  async first(col) { const r = this._p().get(...this.args); return r == null ? null : (col ? r[col] : { ...r }); }
  async all() { return { success: true, results: this._p().all(...this.args).map((r) => ({ ...r })), meta: {} }; }
  async run() {
    const r = this._p().run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async _exec() { return /^\s*(SELECT|WITH)\b/i.test(this.sql) ? this.all() : this.run(); }
}
export class D1 {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec(fs.readFileSync(path.join(ROOT, 'setup/migrations/0001_init.sql'), 'utf8'));
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s._exec()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

