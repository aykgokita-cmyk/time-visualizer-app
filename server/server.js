require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { db, initDatabase } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// データベース初期化 (テーブル、インデックス等)
initDatabase();

// ==============================================================
// セッション & Cookie 設定 (SQLite 永続化ストア)
// ==============================================================
const sessionStore = new SQLiteStore({
  db: 'life._log.sqlite',
  dir: path.resolve(__dirname, '..'),
  table: 'sessions'
});

const isProduction = process.env.NODE_ENV === 'production';
const isCookieSecure = process.env.COOKIE_SECURE === 'true' || isProduction;
const cookieSameSite = process.env.COOKIE_SAMESITE || 'lax';

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'time_visualizer_dev_secret_key_2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isCookieSecure,
    sameSite: cookieSameSite,
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30日間有効
  }
}));

// ==============================================================
// Passport.js 認証設定 (Google OAuth 2.0 / OIDC)
// ==============================================================
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  db.get('SELECT id, google_sub, email, display_name, dashboard_mode FROM users WHERE id = ?', [id], (err, row) => {
    if (err) return done(err);
    done(null, row || null);
  });
});

// Google OAuth キーの設定有無判定 (未設定時は開発用デモモード)
const isGoogleOAuthConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const DEMO_USER_ID = 1;

if (isGoogleOAuthConfigured) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`,
    passReqToCallback: true
  }, (req, accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails[0] ? profile.emails[0].value.toLowerCase() : null;
      const googleSub = profile.id;
      const displayName = profile.displayName || (email ? email.split('@')[0] : 'User');

      // 1. メールアドレス / ドメイン許可チェック（制限設定時のみ）
      const allowedEmails = (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const allowedDomains = (process.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

      if (allowedEmails.length > 0 && (!email || !allowedEmails.includes(email))) {
        return done(null, false, { message: 'domain_not_allowed' });
      }
      if (allowedDomains.length > 0 && (!email || !allowedDomains.some(d => email.endsWith('@' + d)))) {
        return done(null, false, { message: 'domain_not_allowed' });
      }

      // 2. 既存ユーザーの確認
      db.get('SELECT * FROM users WHERE google_sub = ? OR email = ?', [googleSub, email], (err, existingUser) => {
        if (err) return done(err);

        // 開発用リンク設定 (LINK_DEV_USER=true):
        // ログインしたGoogleアカウントを田中 (User ID: 1) のテストデータに自動紐付け
        if (process.env.LINK_DEV_USER === 'true') {
          if (existingUser && existingUser.id === 1) {
            return done(null, existingUser);
          }

          db.get('SELECT * FROM users WHERE id = 1', [], (err, devUser) => {
            if (!err && devUser) {
              // 既に ID != 1 で作成されていた重複ユーザー（例: ID 16）があれば削除して整理
              db.serialize(() => {
                if (existingUser && existingUser.id !== 1) {
                  db.run('DELETE FROM time_blocks WHERE user_id = ?', [existingUser.id]);
                  db.run('DELETE FROM daily_logs WHERE user_id = ?', [existingUser.id]);
                  db.run('DELETE FROM users WHERE id = ?', [existingUser.id]);
                }
                db.run('UPDATE users SET google_sub = ?, email = ?, display_name = ? WHERE id = 1',
                  [googleSub, email, displayName],
                  function(updateErr) {
                    if (updateErr) return done(updateErr);
                    console.log(`[Auth] LINK_DEV_USER=true: Googleアカウント (${email}) を田中 (ID: 1) のテストデータに紐付けました`);
                    return done(null, { ...devUser, id: 1, google_sub: googleSub, email, display_name: displayName });
                  }
                );
              });
              return;
            }

            // ID 1 が見つからない場合は通常処理
            handleStandardUser();
          });
          return;
        }

        handleStandardUser();

        function handleStandardUser() {
          if (existingUser) {
            // Google sub や 表示名のアップデート
            if (!existingUser.google_sub) {
              db.run('UPDATE users SET google_sub = ?, display_name = ? WHERE id = ?', [googleSub, displayName, existingUser.id]);
              existingUser.google_sub = googleSub;
              existingUser.display_name = displayName;
            }
            return done(null, existingUser);
          }

          insertNewUser();
        }

        function insertNewUser() {
          db.run('INSERT INTO users (google_sub, email, display_name) VALUES (?, ?, ?)', [googleSub, email, displayName], function(insertErr) {
            if (insertErr) return done(insertErr);
            done(null, { id: this.lastID, google_sub: googleSub, email, display_name: displayName, dashboard_mode: 'mode_1' });
          });
        }
      });
    } catch (e) {
      done(e);
    }
  }));
} else {
  console.log('[Auth Info] GOOGLE_CLIENT_ID が未設定のため「開発用デモモード（User ID 1 = 田中）」で起動します');
}

// ユーザーID解決ヘルパー
function getUserId(req) {
  // 開発・テスト用リンク設定 (LINK_DEV_USER=true) が有効な場合は、確実に田中のテストデータ (ID: 1) を参照
  if (process.env.LINK_DEV_USER === 'true') {
    return 1;
  }
  if (req.user && req.user.id) return req.user.id;
  if (!isGoogleOAuthConfigured) return DEMO_USER_ID;
  return req.query && req.query.userId ? Number(req.query.userId) : DEMO_USER_ID;
}

// ==============================================================
// 認証ガード ミドルウェア
// ==============================================================
// 画面用ガード: 未ログイン時は /login へリダイレクト
function requireAuthPage(req, res, next) {
  if (!isGoogleOAuthConfigured) {
    if (!req.user) {
      req.user = { id: DEMO_USER_ID, email: 'tanaka@example.com', display_name: '田中 健一 (デモ)' };
    }
    return next();
  }
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  const returnTo = req.originalUrl || '/dashboard';
  res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
}

// API用ガード: 未ログイン時は 401 Unauthorized を返却
function requireAuthApi(req, res, next) {
  if (!isGoogleOAuthConfigured) {
    if (!req.user) {
      req.user = { id: DEMO_USER_ID, email: 'tanaka@example.com', display_name: '田中 健一 (デモ)' };
    }
    return next();
  }
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized', message: 'ログインが必要です。' });
}

// ==============================================================
// 認証・セッション関連 ルーティング
// ==============================================================
// 1. ログイン画面
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// 2. 認証ステータス確認 API
app.get('/auth/status', (req, res) => {
  const isAuth = req.isAuthenticated ? req.isAuthenticated() : false;
  res.json({
    isDemoMode: !isGoogleOAuthConfigured,
    authenticated: isAuth || !isGoogleOAuthConfigured,
    user: req.user ? { id: req.user.id, email: req.user.email, display_name: req.user.display_name } : (isGoogleOAuthConfigured ? null : { id: 1, email: 'tanaka@example.com', display_name: '田中 健一 (デモ)' })
  });
});

// 3. Google OAuth 認証開始
app.get('/auth/google', (req, res, next) => {
  const returnTo = req.query.returnTo || '/dashboard';
  if (!isGoogleOAuthConfigured) {
    // デモモード時はログイン画面または戻り先へ直接リダイレクト
    return res.redirect(returnTo);
  }
  req.session.returnTo = returnTo;
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
    state: returnTo
  })(req, res, next);
});

// 4. Google OAuth コールバック受信
app.get('/auth/google/callback', (req, res, next) => {
  if (!isGoogleOAuthConfigured) {
    return res.redirect('/dashboard');
  }

  passport.authenticate('google', (err, user, info) => {
    if (err) {
      console.error('[OAuth Error]', err);
      return res.redirect('/login?error=auth_failed');
    }
    if (!user) {
      const reason = (info && info.message) || 'auth_failed';
      return res.redirect(`/login?error=${encodeURIComponent(reason)}`);
    }

    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('[Login Error]', loginErr);
        return res.redirect('/login?error=auth_failed');
      }

      // 戻り先の決定 (PC用: /dashboard または / 、スマホ用: /mobile)
      const returnTo = req.session.returnTo || req.query.state || '/dashboard';
      delete req.session.returnTo;
      console.log(`[Auth Success] ユーザー ${user.display_name} (${user.email}) がログインしました -> 戻り先: ${returnTo}`);
      res.redirect(returnTo);
    });
  })(req, res, next);
});

// 5. ログアウトルート (GET / POST 両対応)
const handleLogout = (req, res) => {
  const returnTo = req.query.returnTo || '/login';
  req.logout((err) => {
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect(returnTo);
      });
    } else {
      res.redirect(returnTo);
    }
  });
};
app.get('/auth/logout', handleLogout);
app.post('/auth/logout', handleLogout);

// 6. 現在ログイン中のユーザー情報
app.get('/api/me', (req, res) => {
  if (!isGoogleOAuthConfigured && !req.user) {
    return res.json({
      authenticated: true,
      isDemoMode: true,
      user: { id: 1, email: 'tanaka@example.com', display_name: '田中 健一 (デモ)' }
    });
  }
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ authenticated: false, message: 'ログインしていません' });
  }
  res.json({
    authenticated: true,
    isDemoMode: false,
    user: req.user
  });
});

// ==============================================================
// 静的ファイル配信 & マウント設定
// ==============================================================
// 1. 公開アイコン・アセット (/icons/*) - 認証不要
app.use('/icons', express.static(path.join(__dirname, '../public/icons')));
app.use('/public', express.static(path.join(__dirname, '../public')));

// 2. PCダッシュボード (/dashboard/*) - 認証保護
app.use('/dashboard', requireAuthPage, express.static(path.join(__dirname, '../public/dashboard'), { index: 'pc_dashboard.html' }));

// 3. スマホPWA (/mobile/*) - 認証保護
app.use('/mobile', requireAuthPage, express.static(path.join(__dirname, '../public/mobile'), { index: 'index.html' }));

// 4. public 直下のその他ファイル (フォールバック)
app.use(express.static(path.join(__dirname, '../public')));

// ==============================================================
// Socket.io リアルタイム同期設定 (ユーザー個別ルーム)
// ==============================================================
io.on('connection', (socket) => {
  console.log(`[Socket.io] クライアント接続: ${socket.id}`);

  // ユーザー専用ルームに参加 (例: user_1)
  socket.on('join_user', (userId) => {
    const targetUserId = userId || DEMO_USER_ID;
    const room = `user_${targetUserId}`;
    socket.join(room);
    console.log(`[Socket.io] ソケット ${socket.id} がルーム ${room} に参加しました`);
    socket.emit('joined', { room, userId: targetUserId });
  });

  // クライアント発信のデータ更新通知
  socket.on('notify_update', (payload) => {
    const targetUserId = (payload && payload.userId) || DEMO_USER_ID;
    const room = `user_${targetUserId}`;
    // 本人以外の同室クライアントへブロードキャスト
    socket.to(room).emit('data_updated', payload);
    console.log(`[Socket.io] ルーム ${room} にデータ更新通知をブロードキャスト:`, payload.type);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.io] 切断: ${socket.id}`);
  });
});

// ==============================================================
// API エンドポイント (すべて requireAuthApi で保護)
// ==============================================================
app.use('/api', requireAuthApi);

// 0. 全データ一括取得 API (PCダッシュボード初期表示用)
app.get('/api/dashboard/all-data', (req, res) => {
  const userId = getUserId(req);

  db.get("SELECT id, email, display_name, dashboard_mode FROM users WHERE id = ?", [userId], (userErr, userRow) => {
    if (userErr) {
      return res.status(500).json({ error: userErr.message });
    }

    const user = userRow || { id: userId, display_name: '田中 健太', dashboard_mode: 'mode_1' };

    // 全日次ログ取得
    const logsSql = `
      SELECT log_date, score, satisfaction, memo, sleep_hours, free_hours
      FROM daily_logs
      WHERE user_id = ?
      ORDER BY log_date ASC
    `;

    // 全タイムブロック取得
    const blocksSql = `
      SELECT log_date, start_time, end_time, title, category
      FROM time_blocks
      WHERE user_id = ?
      ORDER BY log_date ASC, start_time ASC
    `;

    db.all(logsSql, [userId], (logsErr, logRows) => {
      if (logsErr) {
        return res.status(500).json({ error: logsErr.message });
      }

      db.all(blocksSql, [userId], (blocksErr, blockRows) => {
        if (blocksErr) {
          return res.status(500).json({ error: blocksErr.message });
        }

        // blocks を log_date ごとにグループ化
        const blocksByDate = {};
        (blockRows || []).forEach(b => {
          if (!blocksByDate[b.log_date]) {
            blocksByDate[b.log_date] = [];
          }
          blocksByDate[b.log_date].push({
            start: b.start_time,
            end: b.end_time,
            title: b.title,
            category: b.category
          });
        });

        // appData 形式にマッピング
        const formattedLogs = {};
        (logRows || []).forEach(l => {
          formattedLogs[l.log_date] = {
            date: l.log_date,
            score: l.score !== null && l.score !== undefined ? l.score : null,
            satisfaction: l.satisfaction !== null && l.satisfaction !== undefined ? l.satisfaction : null,
            sleep_note: l.memo || '',
            diary_note: l.memo || '',
            sleep_hours: l.sleep_hours || 7.0,
            free_hours: l.free_hours || 2.5,
            blocks: blocksByDate[l.log_date] || []
          };
        });

        res.json({
          success: true,
          user,
          total_days: Object.keys(formattedLogs).length,
          logs: formattedLogs
        });
      });
    });
  });
});

// 1. タイムブロック取得 API
app.get('/api/time-blocks', (req, res) => {
  const userId = getUserId(req);
  const { date } = req.query;

  let sql = "SELECT id, user_id, log_date AS date, start_time, end_time, title, category FROM time_blocks WHERE user_id = ?";
  const params = [userId];

  if (date) {
    sql += " AND log_date = ?";
    params.push(date);
  }
  sql += " ORDER BY log_date ASC, start_time ASC";

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 2. ユーザー設定（年間振り返りモード等）の取得・更新
app.get('/api/user/settings', (req, res) => {
  const userId = getUserId(req);
  db.get("SELECT dashboard_mode, display_name, email FROM users WHERE id = ?", [userId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || { dashboard_mode: 'mode_1' });
  });
});

app.post('/api/user/settings', (req, res) => {
  const userId = getUserId(req);
  const { dashboard_mode } = req.body;
  if (!dashboard_mode) {
    return res.status(400).json({ error: 'dashboard_mode is required' });
  }
  db.run("UPDATE users SET dashboard_mode = ? WHERE id = ?", [dashboard_mode, userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, dashboard_mode });
  });
});

// 3. モード1: ベスト＆ワースト日・月別サマリー API
app.get('/api/yearly/summary/mode1', (req, res) => {
  const userId = getUserId(req);
  const year = req.query.year || '2026';

  const bestDayQuery = `
    SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
    FROM daily_logs
    WHERE user_id = ? AND strftime('%Y', log_date) = ? AND memo IS NOT NULL AND memo != ''
    ORDER BY satisfaction DESC, sleep_hours DESC, log_date DESC
    LIMIT 1
  `;

  const worstDayQuery = `
    SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
    FROM daily_logs
    WHERE user_id = ? AND strftime('%Y', log_date) = ? AND memo IS NOT NULL AND memo != ''
    ORDER BY satisfaction ASC, log_date DESC
    LIMIT 1
  `;

  const monthlyQuery = `
    SELECT 
      strftime('%m', log_date) AS month,
      ROUND(AVG(satisfaction), 1) AS avg_satisfaction,
      ROUND(AVG(sleep_hours), 1) AS avg_sleep,
      (
        SELECT memo FROM daily_logs d2 
        WHERE d2.user_id = daily_logs.user_id 
          AND strftime('%Y-%m', d2.log_date) = strftime('%Y-%m', daily_logs.log_date)
          AND d2.memo IS NOT NULL AND d2.memo != ''
        ORDER BY d2.satisfaction DESC, d2.sleep_hours DESC
        LIMIT 1
      ) AS highlight_note
    FROM daily_logs
    WHERE user_id = ? AND strftime('%Y', log_date) = ?
    GROUP BY strftime('%m', log_date)
    ORDER BY month ASC
  `;

  db.get(bestDayQuery, [userId, year], (err, bestDay) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(worstDayQuery, [userId, year], (err2, worstDay) => {
      if (err2) return res.status(500).json({ error: err2.message });

      db.all(monthlyQuery, [userId, year], (err3, monthlySummary) => {
        if (err3) return res.status(500).json({ error: err3.message });

        res.json({
          year,
          best_day: bestDay || null,
          worst_day: worstDay || null,
          monthly_summary: monthlySummary || []
        });
      });
    });
  });
});

// エイリアス
app.get('/api/mode1/summary', (req, res) => res.redirect('/api/yearly/summary/mode1'));
app.get('/api/mode2/timemachine', (req, res) => res.redirect('/api/yearly/summary/mode2'));

// 4. モード2: タイムマシーン API
app.get('/api/yearly/summary/mode2', (req, res) => {
  const userId = getUserId(req);
  const type = req.query.type || 'exact';
  const isRandom = type === 'random';
  const today = '2026-11-25';

  if (isRandom) {
    const randomQuery = `
      SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
      FROM daily_logs
      WHERE user_id = ? AND log_date < ? AND satisfaction >= 4 AND memo IS NOT NULL AND memo != ''
      ORDER BY RANDOM()
      LIMIT 1
    `;
    db.get(randomQuery, [userId, today], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(row || {
        date: '2025-05-18',
        satisfaction: 5,
        score: 5,
        sleep_hours: 8.0,
        note: '【初夏の思い出】朝からベランダに出てコーヒーを飲み、本を1冊読み終えた。静かで満ち足りた一日。'
      });
    });
  } else {
    const sameDayQuery = `
      SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
      FROM daily_logs
      WHERE user_id = ? AND strftime('%m-%d', log_date) = ? AND log_date < ?
      ORDER BY log_date DESC
      LIMIT 1
    `;
    const mmDd = today.slice(5);

    db.get(sameDayQuery, [userId, mmDd, today], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) return res.json(row);

      const fallbackQuery = `
        SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
        FROM daily_logs
        WHERE user_id = ? AND log_date < ? AND memo IS NOT NULL AND memo != ''
        ORDER BY satisfaction DESC, log_date DESC
        LIMIT 1
      `;
      db.get(fallbackQuery, [userId, today], (fErr, fRow) => {
        if (fErr) return res.status(500).json({ error: fErr.message });
        res.json(fRow || {
          date: '2025-11-25',
          satisfaction: 5,
          score: 4,
          sleep_hours: 7.2,
          note: '【1年前の思い出】新しい個人アプリの構想をノートに書き留めた日。将来これが形になるといいなと思いながらワクワクして眠りについた。'
        });
      });
    });
  }
});

// 5. 日次ログ API
app.get('/api/logs/:date', (req, res) => {
  const userId = getUserId(req);
  const { date } = req.params;
  db.get("SELECT id, user_id, log_date AS date, sleep_hours, satisfaction, memo AS note, score, free_hours FROM daily_logs WHERE user_id = ? AND log_date = ?", [userId, date], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || null);
  });
});

app.post('/api/logs', (req, res) => {
  const userId = getUserId(req);
  const { date, score, satisfaction, note, sleep_hours, free_hours } = req.body;
  const sql = `
    INSERT INTO daily_logs (user_id, log_date, score, satisfaction, memo, sleep_hours, free_hours, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, log_date) DO UPDATE SET
      score = excluded.score,
      satisfaction = excluded.satisfaction,
      memo = excluded.memo,
      sleep_hours = excluded.sleep_hours,
      free_hours = excluded.free_hours,
      updated_at = CURRENT_TIMESTAMP
  `;
  const scoreVal = (score !== undefined && score !== null && score !== '') ? Number(score) : null;
  const satVal = (satisfaction !== undefined && satisfaction !== null && satisfaction !== '') ? Number(satisfaction) : null;

  db.run(sql, [userId, date, scoreVal, satVal, note || '', sleep_hours || 0, free_hours || 0], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    // Socket.io で全クライアント（PC・スマホ）に即時同期通知
    io.to(`user_${userId}`).emit('data_updated', {
      type: 'daily_log',
      date,
      score: scoreVal,
      satisfaction: satVal,
      userId,
      updatedAt: new Date().toISOString()
    });
    res.json({ success: true, date, id: this.lastID });
  });
});

// 6. タイムブロックの同期保存 API
app.post('/api/time-blocks/batch', (req, res) => {
  const userId = getUserId(req);
  const { date, blocks } = req.body;
  if (!date || !Array.isArray(blocks)) {
    return res.status(400).json({ error: 'Invalid parameters: date and blocks array required' });
  }

  db.serialize(() => {
    db.run("DELETE FROM time_blocks WHERE user_id = ? AND log_date = ?", [userId, date]);
    const stmt = db.prepare("INSERT INTO time_blocks (user_id, log_date, start_time, end_time, title, category) VALUES (?, ?, ?, ?, ?, ?)");
    blocks.forEach(b => {
      stmt.run(userId, date, b.start, b.end, b.title || '', b.category || 'life');
    });
    stmt.finalize((err) => {
      if (err) return res.status(500).json({ error: err.message });
      // Socket.io でリアルタイム通知
      io.to(`user_${userId}`).emit('data_updated', {
        type: 'time_blocks',
        date,
        count: blocks.length,
        userId
      });
      res.json({ success: true, date, count: blocks.length });
    });
  });
});

// ==============================================================
// フロントエンド ルーティング
// ==============================================================
// ルート (/) アクセス時は /dashboard へリダイレクト
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// 直接アクセス時のフォールバック
app.get('/dashboard', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/pc_dashboard.html'));
});

app.get('/mobile', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mobile/index.html'));
});

// サーバー起動 (Socket.io をアタッチした HTTP サーバーで待受)
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Auth mode: ${isGoogleOAuthConfigured ? 'Google OAuth 2.0 (Active)' : 'Development Demo Mode (Active)'}`);
  console.log(`Socket.io server ready and active on ws/http.`);
});
