const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// プロジェクトルート直下の life._log.sqlite を直接参照
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../life._log.sqlite');

let dbInstance = null;

function getDatabase() {
  if (!dbInstance) {
    dbInstance = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error(`[DB Error] SQLiteへの接続に失敗しました: ${err.message}`);
      } else {
        console.log(`[DB Info] SQLiteに接続しました: ${DB_PATH}`);
      }
    });

    // 接続時に必須のPRAGMA設定を即時適用 (SQLiteの接続スコープPRAGMA対応)
    dbInstance.serialize(() => {
      dbInstance.run('PRAGMA foreign_keys = ON;');
      dbInstance.run('PRAGMA journal_mode = WAL;');
      dbInstance.run('PRAGMA busy_timeout = 5000;');
    });
  }
  return dbInstance;
}

const db = getDatabase();

/**
 * データベースの初期化処理
 * - 各種テーブル作成（users, daily_logs, time_blocks）
 * - パフォーマンス向上のためのインデックス作成
 * @returns {Promise<void>}
 */
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // PRAGMAの確実な再適用
      db.run('PRAGMA foreign_keys = ON;');
      db.run('PRAGMA journal_mode = WAL;');
      db.run('PRAGMA busy_timeout = 5000;');

      // 1. users テーブル (Google OAuth 2.0 / OIDC 対応)
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          google_sub TEXT UNIQUE,
          email TEXT UNIQUE NOT NULL,
          display_name TEXT,
          dashboard_mode TEXT DEFAULT 'mode_1',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // 2. daily_logs テーブル (日次ログ: 睡眠・満足度・一言メモ)
      db.run(`
        CREATE TABLE IF NOT EXISTS daily_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          log_date TEXT NOT NULL,
          sleep_hours REAL DEFAULT 7.0,
          satisfaction INTEGER DEFAULT 3,
          memo TEXT,
          score INTEGER DEFAULT 3,
          free_hours REAL DEFAULT 2.5,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, log_date)
        )
      `);

      // 3. time_blocks テーブル (タイムブロック行動ログ)
      db.run(`
        CREATE TABLE IF NOT EXISTS time_blocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          log_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          title TEXT,
          category TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // 4. インデックス作成 (マルチユーザー検索・日付集計の高速化)
      db.run('CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);');
      db.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);');
      db.run('CREATE INDEX IF NOT EXISTS idx_daily_logs_user_date ON daily_logs(user_id, log_date);');
      db.run('CREATE INDEX IF NOT EXISTS idx_time_blocks_user_date ON time_blocks(user_id, log_date);', (err) => {
        if (err) {
          console.error('[DB Error] データベース初期化に失敗しました:', err);
          return reject(err);
        }
        console.log('[DB Info] データベース初期化完了 (テーブル・インデックス・PRAGMA適用済)');
        resolve();
      });
    });
  });
}

module.exports = {
  db,
  DB_PATH,
  initDatabase
};
