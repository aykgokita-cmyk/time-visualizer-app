const path = require('path');
const { db, DB_PATH, initDatabase } = require('./database');

// SQLiteクエリのPromiseラッパー
const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

// 日付フォーマット (YYYY-MM-DD)
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 日付の加減算
function addDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  return d;
}

// 乱数生成
function randomBetween(min, max, decimals = 0) {
  const val = Math.random() * (max - min) + min;
  return decimals === 0 ? Math.round(val) : parseFloat(val.toFixed(decimals));
}

// 現実味のある日次メモパターン
const MEMO_TEMPLATES = {
  highSatisfaction: [
    '朝から集中して開発を進められた！新機能のプロトタイプが完成。最高の充実感。',
    '7時間半の快眠。午前中の作業効率が圧倒的で、定時前にすべてのタスクを達成。',
    '久しぶりに友人と外食してリフレッシュできた。睡眠もしっかり確保。',
    '週末のランニングと読書が捗った。心身ともにエネルギーが満ちている。',
    '課題だったパフォーマンスチューニングが完了！レスポンスが3倍高速化。',
    '家族とゆっくり過ごし、感謝の気持ちを再確認できた心温まる休日。'
  ],
  normalSatisfaction: [
    '日中は通常通りの業務。少し疲れが出たが、夜の入浴でリセットできた。',
    '6.5時間睡眠。可もなく不可もない一日。早めに布団に入る予定。',
    '午後からミーティングが続いた。タスクの整理をして明日に備える。',
    '淡々と予定をこなせた。スキマ時間に技術書を1章読了。',
    '少し残業があったが、晩御飯を自炊できたので健康的には満足。'
  ],
  lowSatisfaction: [
    '夜更かししてスマホを見てしまい睡眠不足。日中頭がぼーっとしてしまった。反省。',
    '緊急対応でバタバタし、自分のやりたかった勉強時間が確保できなかった。',
    '天気が悪く少し気分が重かった。軽いストレッチをして早めに就寝する。',
    '予定を詰め込みすぎて疲労困憊。明日は意識して休息をとる。'
  ]
};

async function seed() {
  console.log(`[Seed] テストデータ投入を開始します... (対象DB: ${DB_PATH})`);
  await initDatabase();

  const startTime = Date.now();
  await runAsync('BEGIN TRANSACTION;');

  try {
    // ==============================================================
    // 1. テストユーザーの登録 (冪等: ON CONFLICT DO UPDATE)
    // ==============================================================
    const users = [
      {
        google_sub: 'google-sub-100000000000000000001',
        email: 'kenta.tanaka@example.com',
        display_name: '田中 健太 (メイン検証A)',
        dashboard_mode: 'mode_1'
      },
      {
        google_sub: 'google-sub-200000000000000000002',
        email: 'misaki.sato@example.com',
        display_name: '佐藤 美咲 (メイン検証B)',
        dashboard_mode: 'mode_2'
      },
      {
        google_sub: 'google-sub-300000000000000000003',
        email: 'suzuki.isolation@example.com',
        display_name: '鈴木 隔離用 (別データ検証C)',
        dashboard_mode: 'mode_1'
      }
    ];

    for (const u of users) {
      await runAsync(
        `INSERT INTO users (google_sub, email, display_name, dashboard_mode)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           google_sub = excluded.google_sub,
           display_name = excluded.display_name,
           dashboard_mode = excluded.dashboard_mode`,
        [u.google_sub, u.email, u.display_name, u.dashboard_mode]
      );
    }

    // 登録されたユーザーIDの取得
    const dbUsers = await allAsync(
      `SELECT id, email, display_name FROM users WHERE email IN (?, ?, ?)`,
      users.map((u) => u.email)
    );

    const userMap = {};
    dbUsers.forEach((u) => {
      userMap[u.email] = u.id;
    });

    const user1Id = userMap['kenta.tanaka@example.com'];
    const user2Id = userMap['misaki.sato@example.com'];
    const user3Id = userMap['suzuki.isolation@example.com'];

    console.log(`[Seed] 対象ユーザー: User1(ID:${user1Id}), User2(ID:${user2Id}), User3(ID:${user3Id})`);

    // 冪等性確保のため、対象テストユーザーの既存データを初期化
    await runAsync(
      `DELETE FROM time_blocks WHERE user_id IN (?, ?, ?)`,
      [user1Id, user2Id, user3Id]
    );
    await runAsync(
      `DELETE FROM daily_logs WHERE user_id IN (?, ?, ?)`,
      [user1Id, user2Id, user3Id]
    );

    const baseDate = new Date(); // 基準日 (本日)

    // ==============================================================
    // 2. メインユーザー1 (田中 健太): 過去365日分 (1年分のログ＆タイムブロック)
    // ==============================================================
    console.log('[Seed] ユーザー1 (田中 健太): 過去365日分のデータを投入中...');
    let u1LogCount = 0;
    let u1BlockCount = 0;

    for (let i = 365; i >= 0; i--) {
      const targetDate = addDays(baseDate, -i);
      const dateStr = formatDate(targetDate);
      const dayOfWeek = targetDate.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

      let sleepHours = isWeekend ? randomBetween(7.0, 9.0, 1) : randomBetween(5.5, 7.8, 1);
      let satisfaction = randomBetween(2, 5);
      let score = satisfaction;
      let freeHours = isWeekend ? randomBetween(4.0, 7.5, 1) : randomBetween(2.0, 4.5, 1);

      let memo = '';
      if (satisfaction >= 5) {
        memo = MEMO_TEMPLATES.highSatisfaction[i % MEMO_TEMPLATES.highSatisfaction.length];
      } else if (satisfaction <= 2) {
        memo = MEMO_TEMPLATES.lowSatisfaction[i % MEMO_TEMPLATES.lowSatisfaction.length];
      } else {
        memo = MEMO_TEMPLATES.normalSatisfaction[i % MEMO_TEMPLATES.normalSatisfaction.length];
      }

      // 節目や記念日のメモ
      if (i === 365) {
        memo = '【1年前の構想メモ】時間可視化アプリのアイデアを思いついた日。ここから全てが始まった。';
        satisfaction = 5;
      } else if (i === 180) {
        memo = '【半年記念】習慣化の継続日数が180日を突破。睡眠と作業のバランスが明らかに改善してきた。';
        satisfaction = 5;
      } else if (i === 0) {
        memo = '【本日】EC2+Nginx+Socket.ioのマルチユーザー環境検証スタート！';
        satisfaction = 5;
      }

      await runAsync(
        `INSERT INTO daily_logs (user_id, log_date, sleep_hours, satisfaction, memo, score, free_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [user1Id, dateStr, sleepHours, satisfaction, memo, score, freeHours]
      );
      u1LogCount++;

      // タイムブロック (平日/休日パターン)
      const blocks = isWeekend
        ? [
            { start: '00:00', end: '08:30', title: '睡眠 (休日快眠)', cat: 'sleep' },
            { start: '09:00', end: '10:30', title: '朝食・散歩', cat: 'routine' },
            { start: '11:00', end: '13:00', title: '個人開発・学習', cat: 'side_project' },
            { start: '14:00', end: '18:00', title: '趣味・外出・リラックス', cat: 'leisure' },
            { start: '19:00', end: '20:30', title: '夕食・入浴', cat: 'routine' },
            { start: '21:00', end: '23:30', title: '読書・振り返り', cat: 'leisure' }
          ]
        : [
            { start: '00:00', end: '07:00', title: '睡眠', cat: 'sleep' },
            { start: '07:30', end: '08:30', title: '朝の準備・通勤', cat: 'routine' },
            { start: '09:00', end: '12:00', title: 'コア業務 (開発・集中)', cat: 'work' },
            { start: '13:00', end: '18:00', title: '業務 (MTG・設計)', cat: 'work' },
            { start: '19:00', end: '20:00', title: '夕食・休憩', cat: 'routine' },
            { start: '20:30', end: '23:00', title: '自己研鑽・副業', cat: 'side_project' }
          ];

      for (const b of blocks) {
        await runAsync(
          `INSERT INTO time_blocks (user_id, log_date, start_time, end_time, title, category)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [user1Id, dateStr, b.start, b.end, b.title, b.cat]
        );
        u1BlockCount++;
      }
    }

    // ==============================================================
    // 3. メインユーザー2 (佐藤 美咲): 直近90日分 (3ヶ月)
    // ==============================================================
    console.log('[Seed] ユーザー2 (佐藤 美咲): 直近90日分のデータを投入中...');
    let u2LogCount = 0;
    let u2BlockCount = 0;

    for (let i = 90; i >= 0; i--) {
      const targetDate = addDays(baseDate, -i);
      const dateStr = formatDate(targetDate);

      const sleepHours = randomBetween(6.5, 8.2, 1);
      const satisfaction = randomBetween(3, 5);
      const score = satisfaction;
      const freeHours = randomBetween(3.0, 6.0, 1);
      const memo = `【佐藤ログ】UIデザイン作業とユーザー体験レビュー。充実度: ${satisfaction}`;

      await runAsync(
        `INSERT INTO daily_logs (user_id, log_date, sleep_hours, satisfaction, memo, score, free_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [user2Id, dateStr, sleepHours, satisfaction, memo, score, freeHours]
      );
      u2LogCount++;

      const blocks = [
        { start: '01:00', end: '08:00', title: '睡眠 (夜型)', cat: 'sleep' },
        { start: '09:30', end: '12:30', title: 'UIデザイン作業', cat: 'work' },
        { start: '13:30', end: '18:30', title: 'クライアントMTG・修正', cat: 'work' },
        { start: '20:00', end: '22:00', title: 'イラスト制作・リフレッシュ', cat: 'leisure' }
      ];

      for (const b of blocks) {
        await runAsync(
          `INSERT INTO time_blocks (user_id, log_date, start_time, end_time, title, category)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [user2Id, dateStr, b.start, b.end, b.title, b.cat]
        );
        u2BlockCount++;
      }
    }

    // ==============================================================
    // 4. 別データ検証ユーザー3 (鈴木 隔離用): 直近30日分
    //    ※ WHERE user_id = ? 絞り込み時に他人に漏れないかテスト可能
    // ==============================================================
    console.log('[Seed] ユーザー3 (鈴木 隔離用): 直近30日分の隔離検証用データを投入中...');
    let u3LogCount = 0;
    let u3BlockCount = 0;

    for (let i = 30; i >= 0; i--) {
      const targetDate = addDays(baseDate, -i);
      const dateStr = formatDate(targetDate);

      const memo = `[鈴木専用・機密データ] 他ユーザーの画面に漏洩してはいけないログ (${dateStr})`;
      await runAsync(
        `INSERT INTO daily_logs (user_id, log_date, sleep_hours, satisfaction, memo, score, free_hours)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [user3Id, dateStr, 6.0, 3, memo, 3, 2.0]
      );
      u3LogCount++;

      const blocks = [
        { start: '00:00', end: '06:00', title: '[鈴木専用] 睡眠', cat: 'sleep' },
        { start: '09:00', end: '18:00', title: '[鈴木専用] 外部監査・検証業務', cat: 'work' },
        { start: '20:00', end: '22:00', title: '[鈴木専用] 隔離データ確認タスク', cat: 'test' }
      ];

      for (const b of blocks) {
        await runAsync(
          `INSERT INTO time_blocks (user_id, log_date, start_time, end_time, title, category)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [user3Id, dateStr, b.start, b.end, b.title, b.cat]
        );
        u3BlockCount++;
      }
    }

    await runAsync('COMMIT;');
    const elapsed = Date.now() - startTime;

    console.log('--------------------------------------------------');
    console.log(`✅ シードデータ投入が完了しました！ (所要時間: ${elapsed}ms)`);
    console.log(`- ユーザー数: 3名`);
    console.log(`- ユーザー1 (田中 健太): ${u1LogCount} 日分 / ${u1BlockCount} タイムブロック (過去1年)`);
    console.log(`- ユーザー2 (佐藤 美咲): ${u2LogCount} 日分 / ${u2BlockCount} タイムブロック (直近3ヶ月)`);
    console.log(`- ユーザー3 (鈴木 隔離用): ${u3LogCount} 日分 / ${u3BlockCount} タイムブロック (直近30日 漏洩検証用)`);
    console.log('--------------------------------------------------');
  } catch (error) {
    console.error('[Seed Error] シード処理中にエラーが発生したためロールバックします:', error);
    await runAsync('ROLLBACK;');
    throw error;
  }
}

// 直接スクリプト実行された場合
if (require.main === module) {
  seed()
    .then(() => {
      console.log('[Seed] 正常終了しました。');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Seed] エラー終了:', err);
      process.exit(1);
    });
}

module.exports = { seed };
