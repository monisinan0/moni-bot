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

// 未達成時にランダムで使う煽り文言
const TAUNT_MESSAGES = [
  'みんな煽っていいよ🔥',
  'おサボり雑魚しなの❗️叩け叩け❗️',
  'また未達成だってよ、どうする?w',
  '今日も有言不実行、煽っていいぞ',
  '口だけ番長、今日も敗北',
];

function getRandomTaunt() {
  return TAUNT_MESSAGES[Math.floor(Math.random() * TAUNT_MESSAGES.length)];
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
    state.streak = (state.streak || 0) + 1;
    saveState(state);
    await watchChannel.send(
      `✅ 本日全達成！(${achieved.length}/${parsed.items.length})\n` +
      `🔥 連続達成 ${state.streak} 日目！`
    );
  } else {
    state.streak = 0;
    saveState(state);

    const unmetText = unmet.map((i) => i.raw).join('\n');
    await watchChannel.send(
      `未達成あり… (${achieved.length}/${parsed.items.length})\n\n` +
      `【未達成項目】\n${unmetText}\n\n` +
      `${getRandomTaunt()}`
    );
  }
}

// ==========================================
// 正午チェック: 今日の目標がまだ投稿されてないか確認
// ==========================================
async function checkGoalPosted() {
  const now = new Date();
  const todayStr = now.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const state = loadState();

  if (state.lastPingDate === todayStr) return;

  const guild = client.guilds.cache.first();
  if (!guild) return;

  const goalMessage = await fetchLatestGoalMessage(guild);

  const postedToday =
    goalMessage &&
    goalMessage.createdAt.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }) === todayStr;

  if (!postedToday) {
    const watchChannel = await guild.channels.fetch(CHANNEL_WATCH_ID);
    await watchChannel.send('あれ、今日の目標まだ来てない…？👀 もにしなの大丈夫かな');
    state.lastPingDate = todayStr;
    saveState(state);
  }
}

// ==========================================
// スケジュール登録
// ==========================================
function scheduleJobs() {
  cron.schedule('0 1 * * *', () => {
    checkDailyGoal().catch((e) => console.error('checkDailyGoalでエラー:', e));
  }, { timezone: 'Asia/Tokyo' });

  cron.schedule('0 12 * * *', () => {
    checkGoalPosted().catch((e) => console.error('checkGoalPostedでエラー:', e));
  }, { timezone: 'Asia/Tokyo' });

  console.log('スケジュール登録完了');
}

client.login(TOKEN);
