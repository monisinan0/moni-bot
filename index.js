// ==========================================
// もにBot - 目標達成/未達成 自動通知Bot
// ==========================================
// 使い方は README.md を見てね。
// 環境変数(.env または Railwayの設定画面)に下記を設定してください:
//
// DISCORD_TOKEN        Botのトークン
// STREAMER_USER_ID      配信者本人のDiscordユーザーID(目標を宣言する人)
// CHANNEL_GOAL_ID       「今日の目標」チャンネルのID
// CHANNEL_WATCH_ID      「もに監視所」チャンネルのID
// CHANNEL_SCREAM_ID     「悲鳴」チャンネルのID
// ACTIVE_HOURS_START    活動時間の開始(24時間表記、例: 22)
// ACTIVE_HOURS_END      活動時間の終了(24時間表記、例: 24。日をまたぐ場合も0-24の範囲でOK)
//
// ※ トークンなどの秘密情報はコードに直接書かず、必ず環境変数で渡すこと。

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const {
  Client,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const STREAMER_USER_ID = process.env.STREAMER_USER_ID;
const CHANNEL_GOAL_ID = process.env.CHANNEL_GOAL_ID;
const CHANNEL_WATCH_ID = process.env.CHANNEL_WATCH_ID;
const CHANNEL_SCREAM_ID = process.env.CHANNEL_SCREAM_ID;
const ACTIVE_HOURS_START = parseInt(process.env.ACTIVE_HOURS_START || '22', 10);
const ACTIVE_HOURS_END = parseInt(process.env.ACTIVE_HOURS_END || '24', 10);

// 連続達成日数などを保存する簡易ファイル
const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (e) {
    return { streak: 0, lastPingDate: null, lastScreamCheckDate: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once('ready', () => {
  console.log(`ログイン成功: ${client.user.tag}`);
  scheduleJobs();
});

// ==========================================
// 「今日の目標」メッセージを解析する
// ==========================================
// フォーマット例:
// 1️⃣パルクール設定見直し→✅
// 2️⃣歌枠リクエスト曲覚えられるだけ覚える→
// 3️⃣デスクトップ整理→
//
// 番号絵文字(1️⃣〜9️⃣)で始まる行を1項目として数え、
// その行の中に ✅ があれば達成、なければ未達成として扱う。
// 🌙 が本文に含まれる場合は「お休み日」として判定自体をスキップする。

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

function parseGoalMessage(content) {
  if (content.includes('🌙')) {
    return { skip: true };
  }

  const lines = content.split('\n');
  const items = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const numberEmoji = NUMBER_EMOJIS.find((e) => trimmed.startsWith(e));
    if (numberEmoji) {
      const achieved = trimmed.includes('✅');
      items.push({ raw: trimmed, achieved });
    }
  }

  return { skip: false, items };
}

// 「今日の目標」チャンネルから、配信者本人が投稿した直近のメッセージを取得
async function fetchLatestGoalMessage(guild) {
  const channel = await guild.channels.fetch(CHANNEL_GOAL_ID);
  const messages = await channel.messages.fetch({ limit: 20 });
  const streamerMessages = messages
    .filter((m) => m.author.id === STREAMER_USER_ID)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  return streamerMessages.first() || null;
}

// ==========================================
// 深夜1時: 達成/未達成の判定 → 監視所に通知
// ==========================================
async function checkDailyGoal() {
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const watchChannel = await guild.channels.fetch(CHANNEL_WATCH_ID);
  const goalMessage = await fetchLatestGoalMessage(guild);
  const state = loadState();

  if (!goalMessage) {
    await watchChannel.send('今日の目標、まだ投稿されてないっぽい…？');
    return;
  }

  const parsed = parseGoalMessage(goalMessage.content);

  if (parsed.skip) {
    await watchChannel.send('🌙 今日はお休み日として記録します。');
    return;
  }

  if (parsed.items.length === 0) {
    await watchChannel.send('目標メッセージから項目が読み取れなかった…フォーマット確認してほしいかも。');
    return;
  }

  const unmet = parsed.items.filter((i) => !i.achieved);
  const achieved = parsed.items.filter((i) => i.achieved);

  if (unmet.length === 0) {
    // 全達成
    state.streak = (state.streak || 0) + 1;
    saveState(state);
    await watchChannel.send(
      `✅ 本日全達成！(${achieved.length}/${parsed.items.length})\n` +
      `🔥 連続達成 ${state.streak} 日目！`
    );
  } else {
    // 未達成あり
    state.streak = 0;
    saveState(state);

    const unmetText = unmet.map((i) => i.raw).join('\n');
    const notifyMsg = await watchChannel.send(
      `未達成あり… (${achieved.length}/${parsed.items.length})\n\n` +
      `【未達成項目】\n${unmetText}\n\n` +
      `みんな煽っていいよ🔥`
    );

    // 1時間後、反応(リアクション)が無ければ悲鳴チャンネルで騒ぐ
    setTimeout(async () => {
      try {
        const fresh = await watchChannel.messages.fetch(notifyMsg.id);
        const totalReactions = fresh.reactions.cache.reduce((sum, r) => sum + r.count, 0);
        if (totalReactions === 0) {
          const screamChannel = await guild.channels.fetch(CHANNEL_SCREAM_ID);
          await screamChannel.send(
            `未達！！！うわあああああ！！！\n${unmetText}`
          );
        }
      } catch (e) {
        console.error('1時間後チェックでエラー:', e);
      }
    }, 60 * 60 * 1000); // 1時間
  }
}

// ==========================================
// 活動時間中の「沈黙検知」
// ==========================================
// 稼働時間帯(ACTIVE_HOURS_START〜ACTIVE_HOURS_END)の間、
// 「悲鳴」チャンネルに配信者本人の投稿が一定時間(60分)無ければ
// 監視所に「動いてる?」と自動投稿する。1日1回だけ。

async function checkSilence() {
  const now = new Date();
  // Asia/Tokyo基準の時刻を取得
  const jstHour = parseInt(
    now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo', hour: '2-digit', hour12: false })
  );

  const inActiveWindow =
    ACTIVE_HOURS_START <= ACTIVE_HOURS_END
      ? jstHour >= ACTIVE_HOURS_START && jstHour < ACTIVE_HOURS_END
      : jstHour >= ACTIVE_HOURS_START || jstHour < ACTIVE_HOURS_END;

  if (!inActiveWindow) return;

  const state = loadState();
  const todayStr = now.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });

  // 今日すでにピング済みならスキップ
  if (state.lastPingDate === todayStr) return;

  const guild = client.guilds.cache.first();
  if (!guild) return;

  const screamChannel = await guild.channels.fetch(CHANNEL_SCREAM_ID);
  const messages = await screamChannel.messages.fetch({ limit: 20 });
  const streamerMessages = messages.filter((m) => m.author.id === STREAMER_USER_ID);

  const latest = streamerMessages.sort((a, b) => b.createdTimestamp - a.createdTimestamp).first();
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const isSilent = !latest || latest.createdTimestamp < oneHourAgo;

  if (isSilent) {
    const watchChannel = await guild.channels.fetch(CHANNEL_WATCH_ID);
    await watchChannel.send('あれ、もにしなの動いてる…？👀');
    state.lastPingDate = todayStr;
    saveState(state);
  }
}

// ==========================================
// スケジュール登録
// ==========================================
function scheduleJobs() {
  // 毎日深夜1時(JST)に達成判定
  cron.schedule('0 1 * * *', () => {
    checkDailyGoal().catch((e) => console.error('checkDailyGoalでエラー:', e));
  }, { timezone: 'Asia/Tokyo' });

  // 30分おきに沈黙チェック
  cron.schedule('*/30 * * * *', () => {
    checkSilence().catch((e) => console.error('checkSilenceでエラー:', e));
  }, { timezone: 'Asia/Tokyo' });

  console.log('スケジュール登録完了');
}

client.login(TOKEN);
