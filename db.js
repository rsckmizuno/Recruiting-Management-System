// db.js — SQLite schema, seed data, password helpers
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'haken.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ---------- password ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const orig = Buffer.from(hash, 'hex');
  return test.length === orig.length && crypto.timingSafeEqual(test, orig);
}

/* ---------- schema ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_person TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('agency','client')),
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  job_role TEXT NOT NULL,
  qualifications TEXT DEFAULT '',
  experience TEXT DEFAULT '',
  availability TEXT DEFAULT '',
  note TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  job_role TEXT NOT NULL,
  qualification TEXT DEFAULT '',
  rate INTEGER DEFAULT 0,
  facility TEXT DEFAULT '',
  days_per_week TEXT DEFAULT '',
  hours TEXT DEFAULT '',
  contact_person TEXT DEFAULT '',
  start_date TEXT DEFAULT '',
  note TEXT DEFAULT '',
  urgent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'reviewing' CHECK(status IN ('reviewing','accepted','declined')),
  comment TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now','localtime')),
  decided_at TEXT,
  UNIQUE(job_id, staff_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK(sender_role IN ('agency','client')),
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id);
CREATE INDEX IF NOT EXISTS idx_msgs_job ON messages(job_id);
`);

/* ---------- seed ---------- */
function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) return false;

  const insClient = db.prepare('INSERT INTO clients (name, contact_person) VALUES (?,?)');
  const insUser = db.prepare('INSERT INTO users (login_id,password_hash,display_name,role,client_id) VALUES (?,?,?,?,?)');
  const insStaff = db.prepare('INSERT INTO staff (name,job_role,qualifications,experience,availability,note) VALUES (?,?,?,?,?,?)');
  const insJob = db.prepare(`INSERT INTO jobs (client_id,title,job_role,qualification,rate,facility,days_per_week,hours,contact_person,start_date,note,urgent,status,created_by)
    VALUES (@client_id,@title,@job_role,@qualification,@rate,@facility,@days_per_week,@hours,@contact_person,@start_date,@note,@urgent,@status,@created_by)`);
  const insProp = db.prepare('INSERT INTO proposals (job_id,staff_id,status,comment,created_by) VALUES (?,?,?,?,?)');
  const insMsg = db.prepare('INSERT INTO messages (job_id,user_id,sender_role,body) VALUES (?,?,?,?)');

  db.transaction(() => {
    const c1 = insClient.run('さくら総合病院', '人事課 田中').lastInsertRowid;
    const c2 = insClient.run('ひまわり介護センター', '施設長 佐藤').lastInsertRowid;
    const c3 = insClient.run('みどりクリニック', '事務長 鈴木').lastInsertRowid;

    const pw = process.env.SEED_PASSWORD || 'pass';
    const sales = insUser.run('sales01', hashPassword(pw), '営業 高橋', 'agency', null).lastInsertRowid;
    const u1 = insUser.run('sakura', hashPassword(pw), '人事課 田中', 'client', c1).lastInsertRowid;
    const u2 = insUser.run('himawari', hashPassword(pw), '施設長 佐藤', 'client', c2).lastInsertRowid;
    insUser.run('midori', hashPassword(pw), '事務長 鈴木', 'client', c3);

    const s1 = insStaff.run('山田 花子', '看護師', '正看護師', '8年（急性期・外来）', '週3〜4日', '夜勤可、電子カルテ経験あり').lastInsertRowid;
    insStaff.run('高橋 健', '看護師', '正看護師', '5年（療養病棟）', '週5日', '日勤のみ希望');
    insStaff.run('伊藤 美咲', '介護福祉士', '介護福祉士・実務者研修', '6年（特養・デイ）', '週2〜3日', '早番対応可');
    const s4 = insStaff.run('渡辺 大輔', '理学療法士', '理学療法士', '4年（回復期）', '週2日', '訪問リハ経験あり').lastInsertRowid;
    insStaff.run('中村 由紀', '医療事務', '医療事務技能審査', '10年', '週5日', 'レセプト経験豊富');

    const j1 = insJob.run({ client_id: c1, title: '外来看護師（日勤）', job_role: '看護師', qualification: '正看護師', rate: 2800, facility: '本院 2階外来', days_per_week: '週3回', hours: '8:30〜17:30', contact_person: '人事課 田中', start_date: '2026-10-01', note: '採血・点滴業務あり。電子カルテ（富士通）使用。', urgent: 1, status: 'open', created_by: u1 }).lastInsertRowid;
    insJob.run({ client_id: c1, title: '病棟看護師（夜勤あり）', job_role: '看護師', qualification: '正看護師', rate: 3200, facility: '本院 5階病棟', days_per_week: '週4回', hours: '2交代（日勤/夜勤）', contact_person: '人事課 田中', start_date: '2026-10-15', note: '夜勤月4回程度。', urgent: 0, status: 'open', created_by: u1 });
    insJob.run({ client_id: c2, title: '介護職員（早番）', job_role: '介護福祉士', qualification: '介護福祉士 または 初任者研修', rate: 1900, facility: '第2ユニット', days_per_week: '週2回', hours: '7:00〜16:00', contact_person: '施設長 佐藤', start_date: '2026-09-20', note: '急募。送迎業務なし。', urgent: 1, status: 'open', created_by: u2 });
    const j4 = insJob.run({ client_id: c2, title: '理学療法士（機能訓練）', job_role: '理学療法士', qualification: '理学療法士', rate: 2600, facility: 'デイサービス棟', days_per_week: '週2回', hours: '9:00〜17:00', contact_person: '施設長 佐藤', start_date: '2026-10-01', note: '', urgent: 0, status: 'open', created_by: u2 }).lastInsertRowid;
    insJob.run({ client_id: c3, title: '医療事務（受付）', job_role: '医療事務', qualification: '不問（経験者優遇）', rate: 1700, facility: '本院受付', days_per_week: '週5回', hours: '9:00〜18:00', contact_person: '事務長 鈴木', start_date: '2026-09-16', note: '', urgent: 0, status: 'closed', created_by: null });

    insProp.run(j1, s1, 'reviewing', '外来経験8年で即戦力です。', sales);
    insMsg.run(j1, sales, 'agency', '山田さんのスキルシートを提出しました。外来経験8年で即戦力です。');
    insMsg.run(j1, u1, 'client', 'ありがとうございます。来週面談できますか？');
    insProp.run(j4, s4, 'accepted', '', sales);
    insMsg.run(j4, sales, 'agency', '渡辺さんをご提案します。');
    insMsg.run(j4, u2, 'client', '採用で進めます。');
  })();
  return true;
}

if (require.main === module) {
  if (process.argv.includes('--reset')) {
    db.exec('DELETE FROM sessions; DELETE FROM messages; DELETE FROM proposals; DELETE FROM jobs; DELETE FROM staff; DELETE FROM users; DELETE FROM clients;');
    console.log('全データを削除しました');
  }
  console.log(seed() ? '初期データを投入しました' : '既にデータがあるためスキップしました');
}

module.exports = { db, seed, hashPassword, verifyPassword, DB_PATH };
