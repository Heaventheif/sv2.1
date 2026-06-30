// ===================================================
// commands/chess.js — بوت الشطرنج الرسومي v2.1
// ===================================================

const axios = require("axios");

const HF_CHESS_URL = process.env.HF_SPACE_URL || "";
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";
const CHESS_TIMEOUT = 55000;

// ─── تخزين مؤقت في الذاكرة (fallback) ───────────────────────
const activeGames = new Map();

// ═══════════════════════════════════════════════════════════════
// دوال قاعدة البيانات
// ═══════════════════════════════════════════════════════════════

async function getCol() {
  if (!global.db) return null;
  try { return global.db.db("chess_games"); } catch { return null; }
}

async function findActiveGame(threadID, playerID) {
  const col = await getCol();
  if (col) {
    try {
      return await col.findOne({
        threadID,
        status: "active",
        $or: [{ player_white: playerID }, { player_black: playerID }]
      });
    } catch (e) { console.warn("[CHESS DB]", e.message); }
  }
  for (const [, g] of activeGames) {
    if (g.threadID === threadID && g.status === "active" &&
      (g.player_white === playerID || g.player_black === playerID)) return g;
  }
  return null;
}

async function createGame(data) {
  data.status = "active";
  data.createdAt = new Date().toISOString();
  const col = await getCol();
  if (col) {
    try {
      const r = await col.insertOne(data);
      data._id = r.insertedId.toString();
      return data;
    } catch (e) { console.warn("[CHESS DB]", e.message); }
  }
  const id = `${data.threadID}_${Date.now()}`;
  data._id = id;
  activeGames.set(id, { ...data });
  return data;
}

async function updateGame(gameId, updates) {
  const col = await getCol();
  if (col) {
    try {
      const { ObjectId } = require("mongodb");
      let filter;
      try { filter = { _id: new ObjectId(gameId) }; }
      catch { filter = { _id: gameId }; }
      await col.updateOne(filter, { $set: updates });
      return;
    } catch (e) { console.warn("[CHESS DB]", e.message); }
  }
  const g = activeGames.get(String(gameId));
  if (g) activeGames.set(String(gameId), { ...g, ...updates });
}

async function endGame(gameId, winnerId = null) {
  await updateGame(gameId, {
    status: "completed",
    winner: winnerId,
    endedAt: new Date().toISOString()
  });
}

// ═══════════════════════════════════════════════════════════════
// التواصل مع Hugging Face
// ═══════════════════════════════════════════════════════════════

async function callChessEngine(fen, move, botMode = false, difficulty = 3) {
  if (!HF_CHESS_URL) throw new Error("HF_SPACE_URL غير مضبوط في .env");
  const url = `${HF_CHESS_URL.replace(/\/$/, "")}/process_move`;
  const res = await axios.post(url,
    { fen, move: move || null, bot_mode: botMode, difficulty },
    { timeout: CHESS_TIMEOUT, headers: { "Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN } }
  );
  return res.data;
  // يرجع: { new_fen, image_base64, game_over, winner, illegal_move_error }
  // عند bot_mode=true: يطبق نقلة المستخدم + نقلة البوت معاً
  // فيرجع الـ FEN بعد نقلتين، والصورة تعكس موقف البوت
}

// ═══════════════════════════════════════════════════════════════
// دوال مساعدة
// ═══════════════════════════════════════════════════════════════

const STARTING_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const DIFFICULTY_LABELS = {
  1: "1️⃣ مبتدئ جداً",
  2: "2️⃣ مبتدئ",
  3: "3️⃣ متوسط",
  4: "4️⃣ متقدم",
  5: "5️⃣ صعب جداً",
};
const DEFAULT_DIFFICULTY = 3;

function normalizeMove(text) {
  // يقبل "C2 C4" أو "c2c4" أو "c2 c4"
  return text.replace(/\s+/g, "").toLowerCase();
}

function isChessMove(text) {
  return /^[a-h][1-8][a-h][1-8][qrbnQRBN]?$/.test(normalizeMove(text));
}

async function sendBoardImage(api, threadID, messageID, imageBase64, caption) {
  try {
    const { Readable } = require("stream");
    const buf    = Buffer.from(imageBase64, "base64");
    const stream = Readable.from(buf);
    stream.path  = "chess_board.png";
    await new Promise((res, rej) =>
      global.safeSend(api, 
        { body: caption, attachment: stream },
        threadID,
        (err, info) => err ? rej(err) : res(info),
        messageID
      )
    );
  } catch {
    global.safeSend(api, caption + "\n⚠️ (تعذّر إرسال الصورة)", threadID, null, messageID);
  }
}

// ─── نص القواعد الكامل ───────────────────────────────────────
const CHESS_RULES =
`♟️ قواعد بوت الشطرنج الرسومي
━━━━━━━━━━━━━━━━━━━━━━━━━

🚀 بدء لعبة:
  chess bot     — ضد الذكاء الاصطناعي (مستوى متوسط)
  chess bot 1..5 — ضد البوت بمستوى صعوبة محدد
  chess @شخص    — تحدي عضو في المجموعة
  ردّ على رسالة + chess — تحدي صاحبها
  ⚡ الألوان تُحدَّد عشوائياً عند البدء

🎯 مستويات صعوبة البوت:
  1️⃣ مبتدئ جداً — نقلات شبه عشوائية
  2️⃣ مبتدئ
  3️⃣ متوسط (افتراضي)
  4️⃣ متقدم
  5️⃣ صعب جداً — بدون أي عشوائية

🎮 كيف تكتب النقلة (نظام UCI):
  من أين + إلى أين (بمسافة أو بدونها)
  ✅ e2e4   ✅ E2 E4   ✅ e2 e4  (كلها مقبولة)

♟️ النقلات الخاصة:
  • التبييت القصير ← e1g1 (ملك أبيض)
                      e8g8 (ملك أسود)
  • التبييت الطويل ← e1c1 (ملك أبيض)
                      e8c8 (ملك أسود)
  • الأخذ بالتجاوز ← تلقائي (اكتب النقلة العادية)
  • ترقية البيدق:
      e7e8q  — وزير  ♛ (الأقوى، افتراضي)
      e7e8r  — قلعة  ♜
      e7e8b  — فيل   ♝
      e7e8n  — حصان  ♞
    (بدون حرف = ترقية تلقائية لوزير)

⚠️ أثناء اللعبة:
  resign     — استسلام فوري
  chess help — عرض هذه القواعد مجدداً

📌 ملاحظات:
  • لا يمكن بدء لعبتين في نفس الوقت
  • النقلات غير القانونية تُرفض بصمت
  • في لعبة البوت: يرد تلقائياً بعد كل نقلتك`;

// ═══════════════════════════════════════════════════════════════
// الأمر الرئيسي
// ═══════════════════════════════════════════════════════════════

module.exports = {
  config: {
    name: "chess",
    aliases: ["شطرنج"],
    version: "2.1.0",
    author: "Sunken",
    countDown: 5,
    role: 0,
    shortDescription: { ar: "بوت شطرنج رسومي للمجموعات" },
    category: "games",
    guide: { ar: "chess help — لعرض القواعد الكاملة" }
  },

  // ─── onChat: يراقب كل رسائل المجموعة ────────────────────────
  onChat: async function ({ api, event }) {
    const { threadID, senderID, body, messageID } = event;
    if (!body?.trim()) return;
    const raw  = body.trim();
    const text = raw.toLowerCase().trim();

    // ─── chess help ─────────────────────────────────────────
    if (text === "chess help" || text === "شطرنج مساعدة") {
      return global.safeSend(api, CHESS_RULES, threadID, null, messageID);
    }

    // ─── resign / استسلام ───────────────────────────────────
    if (text === "resign" || text === "استسلام") {
      const game = await findActiveGame(threadID, senderID);
      if (!game) return;
      const isWhite    = game.player_white === senderID;
      const winnerId   = isWhite ? game.player_black : game.player_white;
      await endGame(game._id, winnerId);
      const winnerLabel = winnerId === "bot"
        ? "🤖 البوت"
        : `اللاعب ${String(winnerId).slice(-4)}`;
      return global.safeSend(api, 
        `🏳️ استسلم اللاعب!\n🏆 الفائز: ${winnerLabel}`,
        threadID, null, messageID
      );
    }

    // ─── تحقق هل النص نقلة شطرنج ───────────────────────────
    if (!isChessMove(raw)) return;
    const move = normalizeMove(raw);

    // ─── ابحث عن لعبة نشطة ──────────────────────────────────
    const game = await findActiveGame(threadID, senderID);
    if (!game) return; // لا لعبة — تجاهل

    // ─── تحقق من الدور ──────────────────────────────────────
    if (game.current_turn !== senderID) return; // ليس دوره

    // ─── هل اللعبة ضد البوت؟ ────────────────────────────────
    // isBotGame = صحيح → HF يطبق نقلة المستخدم + نقلة البوت معاً
    // ويرجع الـ FEN النهائي بعد النقلتين + صورة موقف البوت
    const isBotGame = game.player_black === "bot" || game.player_white === "bot";

    // ─── أرسل لسيرفر HF ────────────────────────────────────
    let result;
    try {
      result = await callChessEngine(game.fen, move, isBotGame, game.difficulty || DEFAULT_DIFFICULTY);
    } catch (err) {
      return global.safeSend(api, 
        `⚠️ فشل الاتصال بسيرفر الشطرنج\n${err.message?.substring(0, 80)}`,
        threadID, null, messageID
      );
    }

    // ─── نقلة غير قانونية ───────────────────────────────────
    if (result.illegal_move_error) {
      return global.safeSend(api, result.illegal_move_error, threadID, null, messageID);
    }

    // ─── تحديث DB ───────────────────────────────────────────
    if (result.game_over) {
      // حدد الفائز
      let winnerId = null;
      if (result.winner) {
        const winnerIsWhite =
          result.winner === "أبيض" ||
          result.winner === "white" ||
          result.winner.toLowerCase().includes("white") ||
          result.winner.includes("أبيض");
        winnerId = winnerIsWhite ? game.player_white : game.player_black;
      }
      await endGame(game._id, winnerId);
    } else {
      // في لعبة البوت: الدور يرجع للمستخدم (البوت لعب داخل HF)
      // في لعبة لاعب vs لاعب: الدور يتبادل
      const nextTurn = isBotGame
        ? senderID  // ← المفتاح: الدور يعود للمستخدم مباشرة
        : (game.current_turn === game.player_white
            ? game.player_black
            : game.player_white);
      await updateGame(game._id, { fen: result.new_fen, current_turn: nextTurn });
    }

    // ─── بناء caption الصورة ────────────────────────────────
    let caption;
    if (result.game_over) {
      if (result.winner) {
        const winnerIsWhite =
          result.winner === "أبيض" ||
          result.winner.toLowerCase().includes("white") ||
          result.winner.includes("أبيض");
        const winnerId    = winnerIsWhite ? game.player_white : game.player_black;
        const winnerLabel = winnerId === "bot"
          ? "🤖 البوت"
          : `اللاعب ${String(winnerId).slice(-4)}`;
        caption = `♟️ كش مات!\n🏆 الفائز: ${winnerLabel}`;
      } else {
        caption = "🤝 تعادل!";
      }
    } else {
      const isPromo      = move.length === 5;
      const promoLabels  = { q: "وزير ♛", r: "قلعة ♜", b: "فيل ♝", n: "حصان ♞" };
      const promoNote    = isPromo ? `\n⬆️ ترقية إلى ${promoLabels[move[4]] || "وزير ♛"}` : "";

      if (isBotGame) {
        // أظهر نقلة المستخدم + أن البوت لعب
        caption =
          `✅ نقلتك: ${move.toUpperCase()}${promoNote}\n` +
          `🤖 البوت لعب — دورك الآن!`;
      } else {
        const nextTurnId  = game.current_turn === game.player_white
          ? game.player_black : game.player_white;
        const nextLabel   = `اللاعب ${String(nextTurnId).slice(-4)}`;
        caption = `✅ نقلة: ${move.toUpperCase()}${promoNote}\n🎯 دور: ${nextLabel}`;
      }
    }

    await sendBoardImage(api, threadID, messageID, result.image_base64, caption);
  },

  // ─── onStart: أمر chess الأولي ──────────────────────────────
  onStart: async function ({ api, event, args }) {
    const { threadID, senderID, messageID, mentions, messageReply } = event;
    const joinedArgs = args.join(" ").toLowerCase().trim();

    // ─── chess help ─────────────────────────────────────────
    if (["help", "مساعدة", "قواعد"].includes(joinedArgs)) {
      return global.safeSend(api, CHESS_RULES, threadID, null, messageID);
    }

    // ─── chess بدون args ────────────────────────────────────
    if (!joinedArgs && !messageReply && !Object.keys(mentions || {}).length) {
      return global.safeSend(api, 
        "♟️ بوت الشطرنج\n\n" +
        "  chess bot      — ضد البوت (متوسط)\n" +
        "  chess bot 1-5  — ضد البوت بمستوى صعوبة\n" +
        "  chess @شخص     — ضد لاعب\n" +
        "  رد + chess     — تحدي صاحب الرسالة\n" +
        "  chess help     — القواعد والنقلات الخاصة",
        threadID, null, messageID
      );
    }

    // ─── تحقق من لعبة نشطة ──────────────────────────────────
    const existingGame = await findActiveGame(threadID, senderID);
    if (existingGame) {
      return global.safeSend(api, 
        "⚠️ لديك مباراة نشطة!\nاكتب resign لإنهائها أولاً.",
        threadID, null, messageID
      );
    }

    // ─── تحديد المنافس ──────────────────────────────────────
    let opponentID    = null;
    let opponentLabel = "";
    let difficulty    = DEFAULT_DIFFICULTY;

    const botMatch = joinedArgs.match(/^(bot|بوت)(?:\s+([1-5]))?$/);

    if (botMatch) {
      opponentID = "bot";
      if (botMatch[2]) difficulty = parseInt(botMatch[2]);
      opponentLabel = `🤖 البوت (${DIFFICULTY_LABELS[difficulty]})`;

    } else if (Object.keys(mentions || {}).length > 0) {
      opponentID    = Object.keys(mentions)[0];
      opponentLabel = `اللاعب ${String(opponentID).slice(-4)}`;

    } else if (messageReply) {
      opponentID = messageReply.senderID;
      if (!opponentID || opponentID === senderID)
        return global.safeSend(api, "❌ لا يمكنك تحدي نفسك!", threadID, null, messageID);
      opponentLabel = `اللاعب ${String(opponentID).slice(-4)}`;

    } else {
      return global.safeSend(api, 
        "❌ حدد منافسك:\n  chess bot — ضد البوت\n  chess @شخص — ضد لاعب",
        threadID, null, messageID
      );
    }

    // ─── تحقق من لعبة المنافس ────────────────────────────────
    if (opponentID !== "bot") {
      const oppGame = await findActiveGame(threadID, opponentID);
      if (oppGame)
        return global.safeSend(api, "⚠️ هذا اللاعب لديه مباراة نشطة بالفعل!", threadID, null, messageID);
    }

    // ─── تحديد الألوان عشوائياً ─────────────────────────────
    const senderIsWhite = Math.random() < 0.5;
    const player_white  = senderIsWhite ? senderID    : opponentID;
    const player_black  = senderIsWhite ? opponentID  : senderID;

    // الأبيض يبدأ دائماً
    // في لعبة البوت: إذا البوت أبيض، نبدأ بنقلة البوت أولاً
    let first_turn = player_white;

    const senderColor   = senderIsWhite ? "⬜ أبيض" : "⬛ أسود";
    const opponentColor = senderIsWhite ? "⬛ أسود" : "⬜ أبيض";
    const senderLabel   = `اللاعب ${String(senderID).slice(-4)}`;

    // ─── إنشاء اللعبة في DB ──────────────────────────────────
    const game = await createGame({
      threadID,
      player_white,
      player_black,
      current_turn: first_turn,
      fen: STARTING_FEN,
      difficulty,
    });

    // ─── إذا البوت أبيض → ابدأ بنقلة البوت تلقائياً ────────
    let startFen         = STARTING_FEN;
    let startImageB64    = null;
    let botOpeningNote   = "";

    if (opponentID === "bot" && player_white === "bot") {
      // البوت أبيض → يلعب النقلة الأولى تلقائياً
      try {
        const botRes = await callChessEngine(STARTING_FEN, null, true, difficulty);
        // null move مع bot_mode=true → البوت يلعب كأبيض
        startFen      = botRes.new_fen;
        startImageB64 = botRes.image_base64;
        botOpeningNote = "\n🤖 البوت فتح اللعبة — دورك الآن!";
        // ← إصلاح: استخدام updateGame(game._id) مباشرة (تعمل في وضعي
        // MongoDB والذاكرة) بدل البحث اليدوي في activeGames (لا يعمل
        // إطلاقًا إن كانت اللعبة في MongoDB فقط) وبدل كتلة Mongo مكررة.
        await updateGame(game._id, { fen: startFen, current_turn: senderID });
      } catch (e) {
        console.warn("[CHESS] نقلة البوت الأولى فشلت:", e.message);
        // fallback: جلب صورة البداية فقط
        try {
          const r = await callChessEngine(STARTING_FEN, null, false);
          startImageB64 = r.image_base64;
        } catch {}
      }
    } else {
      // جلب صورة الرقعة الافتراضية
      try {
        const r = await callChessEngine(STARTING_FEN, null, false);
        startImageB64 = r.image_base64;
      } catch (e) {
        console.warn("[CHESS] فشل صورة البداية:", e.message);
      }
    }

    // ─── بناء caption البداية ────────────────────────────────
    const firstLabel = player_white === "bot"
      ? "🤖 البوت (لعب بالفعل)"
      : `اللاعب ${String(player_white).slice(-4)}`;

    const caption =
      `♟️ بدأت مباراة شطرنج!\n\n` +
      `${senderColor}: ${senderLabel}\n` +
      `${opponentColor}: ${opponentLabel}\n\n` +
      `🎯 يبدأ: ${firstLabel}${botOpeningNote}\n` +
      (opponentID === "bot" && player_white !== "bot"
        ? "🤖 البوت سيرد تلقائياً بعد كل نقلتك\n"
        : "") +
      `\n💡 chess help — لمعرفة النقلات الخاصة`;
    if (startImageB64) {
      await sendBoardImage(api, threadID, messageID, startImageB64, caption);
    } else {
      global.safeSend(api, caption, threadID, null, messageID);
    }
  }
};
