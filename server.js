// server.js — 派遣募集ボード API + 静的配信
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const { db, seed, hashPassword, verifyPassword, DB_PATH } = require('./db');

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12時間
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

/* ---------- session ---------- */
const q = {
  sessionUser: db.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`),
  insSession: db.prepare('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)'),
  delSession: db.prepare('DELETE FROM sessions WHERE token=?'),
  purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
};
setInterval(() => q.purge.run(Date.now()), 60 * 60 * 1000).unref();

function auth(req, res, next) {
  const token = req.cookies.sid;
  const u = token && q.sessionUser.get(token);
  if (!u || u.expires_at < Date.now() || !u.active) {
    return res.status(401).json({ error: 'ログインが必要です' });
  }
  req.user = { id: u.id, login_id: u.login_id, display_name: u.display_name, role: u.role, client_id: u.client_id };
  next();
}
const agencyOnly = (req, res, next) => req.user.role === 'agency' ? next() : res.status(403).json({ error: '弊社担当者のみ操作できます' });
const clientOnly = (req, res, next) => req.user.role === 'client' ? next() : res.status(403).json({ error: '取引先アカウントのみ操作できます' });

/* ---------- realtime (SSE) ---------- */
const sseClients = new Set();
function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of sseClients) {
    // 取引先には自社に関係するイベントだけ送る
    if (c.user.role === 'client' && event.client_id && event.client_id !== c.user.client_id) continue;
    c.res.write(payload);
  }
}
app.get('/api/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('data: {"type":"hello"}\n\n');
  const c = { res, user: req.user };
  sseClients.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(c); });
});

/* ---------- auth ---------- */
const loginAttempts = new Map(); // 簡易ブルートフォース対策
app.post('/api/login', (req, res) => {
  const { login_id, password } = req.body || {};
  const key = `${req.ip}:${login_id}`;
  const a = loginAttempts.get(key) || { n: 0, t: Date.now() };
  if (a.n >= 10 && Date.now() - a.t < 15 * 60 * 1000) return res.status(429).json({ error: '試行回数が多すぎます。15分後に再試行してください' });
  const u = db.prepare('SELECT * FROM users WHERE login_id=? AND active=1').get(String(login_id || ''));
  if (!u || !verifyPassword(String(password || ''), u.password_hash)) {
    loginAttempts.set(key, { n: a.n + 1, t: Date.now() });
    return res.status(401).json({ error: 'IDまたはパスワードが違います' });
  }
  loginAttempts.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  q.insSession.run(token, u.id, Date.now() + SESSION_TTL_MS);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, maxAge: SESSION_TTL_MS });
  res.json(publicUser(u));
});
app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) q.delSession.run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  const client = u.client_id ? db.prepare('SELECT id,name,contact_person FROM clients WHERE id=?').get(u.client_id) : null;
  res.json({ ...u, client });
});
app.post('/api/me/password', auth, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(String(current || ''), u.password_hash)) return res.status(400).json({ error: '現在のパスワードが違います' });
  if (!next || String(next).length < 6) return res.status(400).json({ error: '新しいパスワードは6文字以上にしてください' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(String(next)), u.id);
  res.json({ ok: true });
});
function publicUser(u) {
  return { id: u.id, login_id: u.login_id, display_name: u.display_name, role: u.role, client_id: u.client_id };
}

/* ---------- clients / users (agency admin) ---------- */
app.get('/api/clients', auth, agencyOnly, (req, res) => {
  res.json(db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM jobs j WHERE j.client_id=c.id AND j.status='open') open_jobs,
    (SELECT group_concat(login_id, ', ') FROM users u WHERE u.client_id=c.id AND u.active=1) logins
    FROM clients c ORDER BY c.name`).all());
});
app.post('/api/clients', auth, agencyOnly, (req, res) => {
  const { name, contact_person, login_id, password, display_name } = req.body || {};
  if (!name || !login_id || !password) return res.status(400).json({ error: '取引先名・ログインID・パスワードは必須です' });
  if (db.prepare('SELECT 1 FROM users WHERE login_id=?').get(login_id)) return res.status(409).json({ error: 'そのログインIDは既に使われています' });
  const out = db.transaction(() => {
    const cid = db.prepare('INSERT INTO clients (name,contact_person) VALUES (?,?)').run(name, contact_person || '').lastInsertRowid;
    db.prepare('INSERT INTO users (login_id,password_hash,display_name,role,client_id) VALUES (?,?,?,?,?)')
      .run(login_id, hashPassword(String(password)), display_name || contact_person || name, 'client', cid);
    return cid;
  })();
  res.status(201).json({ id: out });
});
app.post('/api/clients/:id/users', auth, agencyOnly, (req, res) => {
  const { login_id, password, display_name } = req.body || {};
  const c = db.prepare('SELECT id FROM clients WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: '取引先が見つかりません' });
  if (!login_id || !password) return res.status(400).json({ error: 'ログインIDとパスワードは必須です' });
  if (db.prepare('SELECT 1 FROM users WHERE login_id=?').get(login_id)) return res.status(409).json({ error: 'そのログインIDは既に使われています' });
  const id = db.prepare('INSERT INTO users (login_id,password_hash,display_name,role,client_id) VALUES (?,?,?,?,?)')
    .run(login_id, hashPassword(String(password)), display_name || login_id, 'client', c.id).lastInsertRowid;
  res.status(201).json({ id });
});
app.post('/api/users/:id/reset-password', auth, agencyOnly, (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
  const r = db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(String(password)), req.params.id);
  res.json({ ok: r.changes === 1 });
});

/* ---------- staff (agency) ---------- */
app.get('/api/staff', auth, agencyOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM staff WHERE active=1 ORDER BY job_role, name').all());
});
app.post('/api/staff', auth, agencyOnly, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.job_role) return res.status(400).json({ error: '氏名と職種は必須です' });
  const id = db.prepare('INSERT INTO staff (name,job_role,qualifications,experience,availability,note) VALUES (?,?,?,?,?,?)')
    .run(b.name, b.job_role, b.qualifications || '', b.experience || '', b.availability || '', b.note || '').lastInsertRowid;
  res.status(201).json({ id });
});
app.patch('/api/staff/:id', auth, agencyOnly, (req, res) => {
  const b = req.body || {};
  const cols = ['name', 'job_role', 'qualifications', 'experience', 'availability', 'note', 'active'].filter(k => k in b);
  if (!cols.length) return res.status(400).json({ error: '更新内容がありません' });
  db.prepare(`UPDATE staff SET ${cols.map(c => `${c}=@${c}`).join(',')} WHERE id=@id`).run({ ...b, id: req.params.id });
  res.json({ ok: true });
});

/* ---------- jobs ---------- */
function jobScope(req) {
  // 取引先は自社のみ。弊社は全件（?client_id=で絞り込み）
  if (req.user.role === 'client') return { where: 'j.client_id=?', params: [req.user.client_id] };
  if (req.query.client_id) return { where: 'j.client_id=?', params: [Number(req.query.client_id)] };
  return { where: '1=1', params: [] };
}
function getJob(req, id) {
  const j = db.prepare(`SELECT j.*, c.name client_name FROM jobs j JOIN clients c ON c.id=j.client_id WHERE j.id=?`).get(id);
  if (!j) return null;
  if (req.user.role === 'client' && j.client_id !== req.user.client_id) return null; // 他社の求人は「存在しない」扱い
  return j;
}
app.get('/api/jobs', auth, (req, res) => {
  const { where, params } = jobScope(req);
  const rows = db.prepare(`
    SELECT j.*, c.name client_name,
      (SELECT COUNT(*) FROM proposals p WHERE p.job_id=j.id) proposal_count,
      (SELECT COUNT(*) FROM proposals p WHERE p.job_id=j.id AND p.status='reviewing') reviewing_count,
      (SELECT sender_role FROM messages m WHERE m.job_id=j.id ORDER BY m.id DESC LIMIT 1) last_sender,
      (SELECT created_at FROM messages m WHERE m.job_id=j.id ORDER BY m.id DESC LIMIT 1) last_message_at
    FROM jobs j JOIN clients c ON c.id=j.client_id
    WHERE ${where}
    ORDER BY j.status='open' DESC, j.urgent DESC, j.created_at DESC`).all(...params);
  res.json(rows);
});
app.get('/api/jobs/:id', auth, (req, res) => {
  const j = getJob(req, req.params.id);
  if (!j) return res.status(404).json({ error: '募集が見つかりません' });
  const proposals = db.prepare(`SELECT p.*, s.name staff_name, s.job_role, s.qualifications, s.experience, s.availability, s.note staff_note
    FROM proposals p JOIN staff s ON s.id=p.staff_id WHERE p.job_id=? ORDER BY p.id`).all(j.id);
  const messages = db.prepare(`SELECT m.id, m.sender_role, m.body, m.created_at, u.display_name FROM messages m JOIN users u ON u.id=m.user_id WHERE m.job_id=? ORDER BY m.id`).all(j.id);
  res.json({ ...j, proposals, messages });
});
const JOB_COLS = ['title', 'job_role', 'qualification', 'rate', 'facility', 'days_per_week', 'hours', 'contact_person', 'start_date', 'note', 'urgent'];
app.post('/api/jobs', auth, clientOnly, (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.job_role) return res.status(400).json({ error: '募集タイトルと職種は必須です' });
  const row = { client_id: req.user.client_id, created_by: req.user.id };
  for (const k of JOB_COLS) row[k] = b[k] ?? '';
  row.rate = Number(row.rate) || 0; row.urgent = b.urgent ? 1 : 0;
  const id = db.prepare(`INSERT INTO jobs (client_id,created_by,${JOB_COLS.join(',')}) VALUES (@client_id,@created_by,${JOB_COLS.map(c => '@' + c).join(',')})`).run(row).lastInsertRowid;
  broadcast({ type: 'job.created', job_id: id, client_id: req.user.client_id });
  res.status(201).json({ id });
});
app.patch('/api/jobs/:id', auth, (req, res) => {
  const j = getJob(req, req.params.id);
  if (!j) return res.status(404).json({ error: '募集が見つかりません' });
  const b = req.body || {};
  const allowed = req.user.role === 'client' ? [...JOB_COLS, 'status'] : ['status']; // 弊社は状態変更のみ
  const cols = allowed.filter(k => k in b);
  if (!cols.length) return res.status(400).json({ error: '更新内容がありません' });
  if ('status' in b && !['open', 'closed'].includes(b.status)) return res.status(400).json({ error: 'status が不正です' });
  const row = { id: j.id };
  for (const k of cols) row[k] = k === 'urgent' ? (b[k] ? 1 : 0) : k === 'rate' ? Number(b[k]) || 0 : b[k];
  db.prepare(`UPDATE jobs SET ${cols.map(c => `${c}=@${c}`).join(',')}, updated_at=datetime('now','localtime') WHERE id=@id`).run(row);
  broadcast({ type: 'job.updated', job_id: j.id, client_id: j.client_id });
  res.json({ ok: true });
});

/* ---------- proposals ---------- */
app.post('/api/jobs/:id/proposals', auth, agencyOnly, (req, res) => {
  const j = getJob(req, req.params.id);
  if (!j) return res.status(404).json({ error: '募集が見つかりません' });
  if (j.status !== 'open') return res.status(400).json({ error: '終了した募集には提案できません' });
  const { staff_id, comment } = req.body || {};
  const s = db.prepare('SELECT * FROM staff WHERE id=? AND active=1').get(staff_id);
  if (!s) return res.status(400).json({ error: 'スタッフが見つかりません' });
  if (db.prepare('SELECT 1 FROM proposals WHERE job_id=? AND staff_id=?').get(j.id, s.id)) return res.status(409).json({ error: 'このスタッフは既に提案済みです' });
  db.transaction(() => {
    db.prepare('INSERT INTO proposals (job_id,staff_id,comment,created_by) VALUES (?,?,?,?)').run(j.id, s.id, comment || '', req.user.id);
    db.prepare('INSERT INTO messages (job_id,user_id,sender_role,body) VALUES (?,?,?,?)')
      .run(j.id, req.user.id, 'agency', `${s.name}さんのスキルシートを提出しました。${comment ? ' ' + comment : ''}`);
  })();
  broadcast({ type: 'proposal.created', job_id: j.id, client_id: j.client_id });
  res.status(201).json({ ok: true });
});
app.patch('/api/proposals/:id', auth, clientOnly, (req, res) => {
  const p = db.prepare('SELECT p.*, j.client_id FROM proposals p JOIN jobs j ON j.id=p.job_id WHERE p.id=?').get(req.params.id);
  if (!p || p.client_id !== req.user.client_id) return res.status(404).json({ error: '提案が見つかりません' });
  const { status } = req.body || {};
  if (!['accepted', 'declined', 'reviewing'].includes(status)) return res.status(400).json({ error: 'status が不正です' });
  const s = db.prepare('SELECT name FROM staff WHERE id=?').get(p.staff_id);
  db.transaction(() => {
    db.prepare(`UPDATE proposals SET status=?, decided_at=datetime('now','localtime') WHERE id=?`).run(status, p.id);
    const text = status === 'accepted' ? `${s.name}さん、面談・採用の方向で進めます。` : status === 'declined' ? `${s.name}さんは今回見送らせてください。` : `${s.name}さんの判断を保留に戻しました。`;
    db.prepare('INSERT INTO messages (job_id,user_id,sender_role,body) VALUES (?,?,?,?)').run(p.job_id, req.user.id, 'client', text);
  })();
  broadcast({ type: 'proposal.updated', job_id: p.job_id, client_id: p.client_id });
  res.json({ ok: true });
});

/* ---------- messages ---------- */
app.post('/api/jobs/:id/messages', auth, (req, res) => {
  const j = getJob(req, req.params.id);
  if (!j) return res.status(404).json({ error: '募集が見つかりません' });
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'メッセージを入力してください' });
  if (body.length > 2000) return res.status(400).json({ error: 'メッセージは2000文字以内にしてください' });
  const id = db.prepare('INSERT INTO messages (job_id,user_id,sender_role,body) VALUES (?,?,?,?)').run(j.id, req.user.id, req.user.role, body).lastInsertRowid;
  broadcast({ type: 'message.created', job_id: j.id, client_id: j.client_id });
  res.status(201).json({ id });
});

/* ---------- misc ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'サーバーエラーが発生しました' }); });

seed();
app.listen(PORT, () => console.log(`派遣募集ボード: http://localhost:${PORT}  (DB: ${DB_PATH})`));
