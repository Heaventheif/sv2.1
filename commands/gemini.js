const axios    = require("axios");
const mongoose = require("mongoose");

const HF_BASE = process.env.HF_SPACE_URL || "";
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";

// ─── Schema للجلسات ──────────────────────────────────────────
const sessionSchema = new mongoose.Schema({
  _id:     String,
  messages: { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now },
});
const Session = mongoose.models.GeminiSession || mongoose.model("GeminiSession", sessionSchema);

async function loadCtx(id) {
  try {
    if (!global.db) return [];
    const doc = await Session.findById(id).lean();
    return doc?.messages?.slice(-20) || [];
  } catch (_) { return []; }
}

async function saveCtx(id, messages) {
  try {
    if (!global.db) return;
    await Session.findByIdAndUpdate(
      id,
      { messages: messages.slice(-20), updatedAt: new Date() },
      { upsert: true }
    );
  } catch (_) {}
}

// ─── تعقيم اسم المستخدم قبل حقنه في محتوى الذكاء الاصطناعي ────
function sanitizeName(name) {
  if (!name) return "مستخدم";
  const clean = String(name)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[[\]{}<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return clean || "مستخدم";
}

async function callHF(endpoint, messages) {
  if (!HF_BASE) throw new Error("HF_SPACE_URL غير مضبوط في متغيرات Render");
  const { data } = await axios.post(
    `${HF_BASE.replace(/\/+$/, "")}/${endpoint}`,
    { messages },
    { timeout: 30000, headers: { "Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN } }
  );
  if (!data.reply) throw new Error("استجابة فارغة");
  return data.reply;
}

async function handle(api, event, prompt, registerReply) {
  // ✅ الجلسة الجماعية: threadID بدل senderID
  const { threadID, messageID, senderID } = event;
  const sessionKey = threadID;

  if (prompt.trim().toLowerCase() === "clear" || prompt.trim() === "مسح") {
    try { await Session.findByIdAndDelete(sessionKey); } catch (_) {}
    return global.safeSend(api, "🧹 تم مسح ذاكرة المجموعة.", threadID, null, messageID);
  }

  if (!prompt.trim()) {
    return global.safeSend(api, 
      "🤖 Sunken AI\n\nأرسل سؤالك مع الأمر\nمثال: .gemini ما هي عاصمة فرنسا؟\n.gemini مسح — لمسح ذاكرة المجموعة",
      threadID, null, messageID
    );
  }

  // ✅ جلب اسم المرسل
  let senderDisplayName = senderID;
  try {
    const userInfo = await new Promise((res, rej) =>
      api.getUserInfo(senderID, (err, data) => err ? rej(err) : res(data))
    );
    senderDisplayName = userInfo?.[senderID]?.name || senderID;
  } catch (_) {}
  senderDisplayName = sanitizeName(senderDisplayName);

  const ctx = await loadCtx(sessionKey);
  const userContent = `[${senderDisplayName}]: ${prompt.trim()}`;

  const messages = [
    ...ctx,
    { role: "user", content: userContent },
  ];

  let reply;
  try {
    reply = await callHF("gemini", messages);
  } catch (e) {
    console.error("[GEMINI→HF]", e.response?.status, e.message?.substring(0, 60));
    const msg = e.message?.includes("HF_SPACE_URL")
      ? "❌ HF_SPACE_URL غير مضبوط في متغيرات البيئة."
      : "❌ الخادم غير متاح حالياً، حاول لاحقاً.";
    return global.safeSend(api, msg, threadID, null, messageID);
  }

  global.safeSend(api, reply, threadID, (err, info) => {
    if (err || !info) return;
    if (registerReply) {
      registerReply(info.messageID, { author: senderID }, async ({ api, event }) => {
        await handle(api, event, event.body?.trim() || "", registerReply);
      });
    }
  }, messageID);

  await saveCtx(sessionKey, [
    ...ctx,
    { role: "user",      content: userContent },
    { role: "assistant", content: reply },
  ]);
}

module.exports = {
  config: {
    name: "gemini",
    aliases: ["بوت", "ai", "gm"],
    version: "9.0.0",
    author: "Sunken",
    countDown: 5,
    role: 0,
    shortDescription: { ar: "محادثة ذكية جماعية — Gemini + MongoDB" },
    category: "ذكاء اصطناعي",
    guide: { ar: "{pn}gemini [سؤال]\n{pn}gemini مسح" },
  },

  onStart: async ({ api, event, args, message }) => {
    const prompt = args.join(" ").trim() || event.messageReply?.body || "";
    await handle(api, event, prompt, message?.registerReply);
  },

  onReply: async ({ api, event, message }) => {
    await handle(api, event, event.body?.trim() || "", message?.registerReply);
  },
};