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
    // setup/migrations の SQL を番号順に、まだ当てていないものだけ実行
    this.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)');
    const dir = path.join(ROOT, 'setup/migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      if (this.db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(f)) continue;
      this.db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      this.db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f);
    }
  }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s._exec()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

