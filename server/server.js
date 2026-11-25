const express = require('express');
const cors = require('cors');
const path = require('path');
const { db, initDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==============================================================
// 静的ファイル配信 & マウント設定 (スコープ明確化・パスズレ防止)
// ==============================================================
// 1. 共有アイコン・アセット (/icons/*)
app.use('/icons', express.static(path.join(__dirname, '../public/icons')));

// 2. PCダッシュボード (/dashboard/*) -> デフォルトで pc_dashboard.html を返却
app.use('/dashboard', express.static(path.join(__dirname, '../public/dashboard'), { index: 'pc_dashboard.html' }));

// 3. スマホPWA (/mobile/*) -> デフォルトで index.html を返却
app.use('/mobile', express.static(path.join(__dirname, '../public/mobile'), { index: 'index.html' }));

// 4. public 直下のその他ファイル (フォールバック)
app.use(express.static(path.join(__dirname, '../public')));

// データベース初期化
initDatabase();

// デモ用固定ユーザーID (認証がある場合は req.user.id から取得)
const DEMO_USER_ID = 1;

// ==============================================================
// 0. 全データ一括取得 API (PCダッシュボード初期表示用)
// ==============================================================
app.get('/api/dashboard/all-data', (req, res) => {
  const userId = req.query.userId || DEMO_USER_ID;

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
            score: l.score || 3,
            satisfaction: l.satisfaction || 3,
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

// ==============================================================
// 1. ユーザー設定 API (dashboard_mode の取得・保存)
// ==============================================================

// GET /api/user/settings
app.get('/api/user/settings', (req, res) => {
  db.get("SELECT dashboard_mode FROM users WHERE id = ?", [DEMO_USER_ID], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to retrieve settings', details: err.message });
    }
    const mode = row ? row.dashboard_mode : 'mode_1';
    res.json({ dashboard_mode: mode });
  });
});

// POST /api/user/settings
app.post('/api/user/settings', (req, res) => {
  const { dashboard_mode } = req.body;
  if (!dashboard_mode || !['mode_1', 'mode_2'].includes(dashboard_mode)) {
    return res.status(400).json({ error: 'Invalid dashboard_mode. Must be mode_1 or mode_2' });
  }

  db.run(
    "UPDATE users SET dashboard_mode = ? WHERE id = ?",
    [dashboard_mode, DEMO_USER_ID],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to save settings', details: err.message });
      }
      res.json({ success: true, dashboard_mode });
    }
  );
});

// ==============================================================
// 2. 年間総括用 API (モード1: ハイライト＆月別 / モード2: タイムマシン)
// ==============================================================

const handleSummaryMode1 = (req, res) => {
  const year = req.query.year || '2026';

  // 1. 最高満足度の日 (同率の場合は最新日または睡眠時間が長い方)
  const bestDayQuery = `
    SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
    FROM daily_logs
    WHERE user_id = ? AND strftime('%Y', log_date) = ? AND memo IS NOT NULL AND memo != ''
    ORDER BY satisfaction DESC, sleep_hours DESC, log_date DESC
    LIMIT 1
  `;

  // 2. 最低満足度の日 (学び・気づき用)
  const worstDayQuery = `
    SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
    FROM daily_logs
    WHERE user_id = ? AND strftime('%Y', log_date) = ? AND memo IS NOT NULL AND memo != ''
    ORDER BY satisfaction ASC, log_date DESC
    LIMIT 1
  `;

  // 3. 月別の平均満足度・平均睡眠時間・代表コメント
  const monthlyQuery = `
    SELECT 
      strftime('%m', log_date) as month,
      ROUND(AVG(satisfaction), 2) as avg_satisfaction,
      ROUND(AVG(sleep_hours), 2) as avg_sleep,
      COUNT(*) as log_count,
      (
        SELECT memo FROM daily_logs l2 
        WHERE l2.user_id = daily_logs.user_id 
          AND strftime('%Y-%m', l2.log_date) = strftime('%Y-%m', daily_logs.log_date)
          AND l2.memo IS NOT NULL AND l2.memo != ''
        ORDER BY l2.satisfaction DESC, l2.log_date DESC LIMIT 1
      ) as highlight_note
    FROM daily_logs
    WHERE user_id = ? AND strftime('%Y', log_date) = ?
    GROUP BY strftime('%m', log_date)
    ORDER BY month ASC
  `;

  db.get(bestDayQuery, [DEMO_USER_ID, year], (err, bestDay) => {
    if (err) return res.status(500).json({ error: err.message });

    db.get(worstDayQuery, [DEMO_USER_ID, year], (err, worstDay) => {
      if (err) return res.status(500).json({ error: err.message });

      db.all(monthlyQuery, [DEMO_USER_ID, year], (err, monthly) => {
        if (err) return res.status(500).json({ error: err.message });

        res.json({
          year,
          best_day: bestDay || null,
          worst_day: worstDay || null,
          monthly_summary: monthly || []
        });
      });
    });
  });
};

app.get('/api/summary/mode1', handleSummaryMode1);
app.get('/api/yearly/summary/mode1', handleSummaryMode1);

// GET /api/summary/mode2 (タイムマシン: 過去の同日またはランダム過去ログ)
const handleSummaryMode2 = (req, res) => {
  const targetDate = req.query.date || new Date().toISOString().split('T')[0];
  const isRandom = req.query.random === 'true' || req.query.random === '1' || req.query.type === 'random';

  const [tYear, tMonth, tDay] = targetDate.split('-');
  const mmdd = `${tMonth}-${tDay}`;

  if (isRandom) {
    // ランダムに過去の良き思い出（満足度4以上）を抽出
    const randomQuery = `
      SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
      FROM daily_logs
      WHERE user_id = ? AND log_date < ? AND satisfaction >= 4 AND memo IS NOT NULL AND memo != ''
      ORDER BY RANDOM()
      LIMIT 1
    `;
    db.get(randomQuery, [DEMO_USER_ID, targetDate], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        type: 'random',
        matched: !!row,
        log: row || null
      });
    });
  } else {
    // 過去の同月同日（例: 1年前、2年前のMM-DD）を検索
    const sameDayQuery = `
      SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
      FROM daily_logs
      WHERE user_id = ? AND strftime('%m-%d', log_date) = ? AND log_date < ?
      ORDER BY log_date DESC
      LIMIT 1
    `;
    db.get(sameDayQuery, [DEMO_USER_ID, mmdd, targetDate], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });

      if (row) {
        return res.json({
          type: 'exact_day',
          matched: true,
          target_mmdd: mmdd,
          log: row
        });
      }

      // 同月同日がない場合は直近の過去高満足度ログをフォールバック
      const fallbackQuery = `
        SELECT log_date AS date, satisfaction, score, memo AS note, sleep_hours, free_hours
        FROM daily_logs
        WHERE user_id = ? AND log_date < ? AND memo IS NOT NULL AND memo != ''
        ORDER BY satisfaction DESC, log_date DESC
        LIMIT 1
      `;
      db.get(fallbackQuery, [DEMO_USER_ID, targetDate], (err, fallbackRow) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
          type: 'fallback',
          matched: false,
          target_mmdd: mmdd,
          log: fallbackRow || null
        });
      });
    });
  }
};

app.get('/api/summary/mode2', handleSummaryMode2);
app.get('/api/yearly/summary/mode2', handleSummaryMode2);

// ==============================================================
// 3. 日次ログ保存・取得 API
// ==============================================================
app.get('/api/logs/:date', (req, res) => {
  const { date } = req.params;
  db.get("SELECT id, user_id, log_date AS date, sleep_hours, satisfaction, memo AS note, score, free_hours FROM daily_logs WHERE user_id = ? AND log_date = ?", [DEMO_USER_ID, date], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || null);
  });
});

app.post('/api/logs', (req, res) => {
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
  db.run(sql, [DEMO_USER_ID, date, score || 3, satisfaction || 3, note || '', sleep_hours || 0, free_hours || 0], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, date, id: this.lastID });
  });
});

// ==============================================================
// フロントエンド ルーティング
// ==============================================================
// ルート (/) アクセス時は /dashboard へリダイレクト (URL正規化)
app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

// 直接アクセス時・末尾スラッシュなしアクセスのフォールバック
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/pc_dashboard.html'));
});

app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/mobile/index.html'));
});

// サーバー起動
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
