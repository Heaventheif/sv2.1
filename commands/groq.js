const axios    = require("axios");
const mongoose = require("mongoose");

const HF_BASE = process.env.HF_SPACE_URL || "";
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";

// ─── Schema للجلسات ──────────────────────────────────────────
const sessionSchema = new mongoose.Schema({
  _id:      String,
  messages: { type: Array, default: [] },
  updatedAt: { type: Date, default: Date.now },
});
const Session = mongoose.models.GroqSession
  || mongoose.model("GroqSession", sessionSchema);

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

async function downloadImageAsBase64(url) {
  try {
    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const contentType = response.headers["content-type"] || "image/jpeg";
    const base64 = Buffer.from(response.data).toString("base64");
    return { base64, contentType };
  } catch (e) {
    console.warn("[GROQ] فشل تحميل الصورة:", e.message?.substring(0, 60));
    return null;
  }
}

function detectAttachment(event) {
  const sources = [
    ...(event.attachments               || []),
    ...(event.messageReply?.attachments || []),
  ];

  for (const att of sources) {
    if (!att) continue;
    const type = (att.type || att.attachmentType || "").toLowerCase();

    if (["photo","image","sticker","animated_image","share"].includes(type)) {
      const url =
        att.largePreviewUrl || att.previewUrl ||
        att.largePreviewUri || att.previewUri ||
        att.uri || att.url  || att.thumbnailUrl ||
        att.image?.uri;
      if (url) return { kind: "image", url };
    }
    if (type === "audio" || type === "voice_message") {
      const url = att.url || att.audioUrl || att.uri;
      if (url) return { kind: "audio", url };
    }
    if (type === "video" || type === "video_inline") {
      const url = att.url || att.uri || att.previewUrl;
      if (url) return { kind: "video", url };
    }
    if (type === "file" || type === "document") {
      const ext = (att.filename || att.name || "").split(".").pop().toLowerCase();
      const url = att.url || att.uri;
      if (!url) continue;
      if (["jpg","jpeg","png","gif","webp","bmp"].includes(ext))
        return { kind: "image", url };
      if (["mp3","m4a","ogg","wav","flac","aac"].includes(ext))
        return { kind: "audio", url };
      if (["mp4","mov","avi","mkv","webm"].includes(ext))
        return { kind: "video", url };
    }
  }
  return null;
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

async function callHF(messages) {
  if (!HF_BASE) throw new Error("HF_SPACE_URL غير مضبوط في متغيرات Render");
  const { data } = await axios.post(
    `${HF_BASE.replace(/\/+$/, "")}/groq`,
    { messages },
    { timeout: 60000, headers: { "Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN } }
  );
  if (!data.reply) throw new Error(data.error || "استجابة فارغة");
  return data.reply;
}

async function handle(api, event, prompt, registerReply) {
  // ✅ الجلسة الجماعية: threadID بدل senderID
  const { threadID, messageID, senderID } = event;
  const sessionKey = threadID;

  if (["clear","مسح","reset"].includes(prompt.trim().toLowerCase())) {
    try { await Session.findByIdAndDelete(sessionKey); } catch (_) {}
    return global.safeSend(api, "🧹 تم مسح ذاكرة المجموعة.", threadID, null, messageID);
  }

  const attachment = detectAttachment(event);

  if (!prompt.trim() && !attachment) {
    return global.safeSend(api, 
      "❓ اكتب سؤالك أو أرسل صورة/صوت/فيديو!\n" +
      "مثال: .ai2 ما هي عاصمة فرنسا؟\n" +
      ".ai2 مسح — لمسح ذاكرة المجموعة",
      threadID, null, messageID
    );
  }

  // ✅ جلب اسم المرسل
  let senderName = senderID;
  try {
    const userInfo = await new Promise((res, rej) =>
      api.getUserInfo(senderID, (err, data) => err ? rej(err) : res(data))
    );
    senderName = userInfo?.[senderID]?.name || senderID;
  } catch (_) {}
  senderName = sanitizeName(senderName);

  let statusMsgId = null;
  try {
    const sent = await new Promise((resolve, reject) =>
      global.safeSend(api, 
        attachment
          ? `⏳ جاري تحليل ${attachment.kind === "image" ? "الصورة 🖼️" : attachment.kind === "audio" ? "الصوت 🎵" : "الفيديو 🎬"}...`
          : "⏳ جاري المعالجة...",
        threadID,
        (err, info) => err ? reject(err) : resolve(info),
        messageID
      )
    );
    statusMsgId = sent?.messageID;
  } catch (_) {}

  const updateStatus = async (text) => {
    try { if (statusMsgId) await api.editMessage(text, statusMsgId); } catch (_) {}
  };

  const ctx = await loadCtx(sessionKey);

  // ✅ نضيف اسم المرسل لكل رسالة
  const displayPrompt = prompt.trim() || (attachment?.kind === "audio" ? "فرّغ هذا الصوت" : attachment?.kind === "video" ? "حلل هذا الفيديو" : "وصف هذه الصورة");
  const attPrefix = attachment ? `[${attachment.kind === "image" ? "صورة" : attachment.kind === "audio" ? "صوت" : "فيديو"}] ` : "";
  const userContent = `[${senderName}]: ${attPrefix}${displayPrompt}`.trim();

  let userMsg;

  if (attachment?.kind === "image") {
    const imgData = await downloadImageAsBase64(attachment.url);
    if (imgData) {
      userMsg = {
        role: "user",
        content: `[${senderName}]: ${prompt.trim() || "وصف هذه الصورة"}`,
        attachment: {
          kind:        "image",
          base64:      imgData.base64,
          contentType: imgData.contentType,
        },
      };
    } else {
      userMsg = { role: "user", content: `[${senderName}]: ${prompt.trim() || "وصف هذه الصورة"}` };
      await updateStatus("⚠️ تعذّر تحميل الصورة، سأجيب على النص فقط...");
    }
  } else if (attachment) {
    userMsg = {
      role: "user",
      content: `[${senderName}]: ${displayPrompt}`,
      attachment: { kind: attachment.kind, url: attachment.url },
    };
  } else {
    userMsg = { role: "user", content: userContent };
  }

  const messages = [...ctx, userMsg];

  let reply;
  try {
    reply = await callHF(messages);
  } catch (e) {
    console.error("[GROQ→HF]", e.response?.status, e.message?.substring(0, 80));
    const msg = e.message?.includes("HF_SPACE_URL")
      ? "❌ HF_SPACE_URL غير مضبوط في متغيرات البيئة."
      : "❌ الخادم غير متاح حالياً، حاول لاحقاً.";
    return updateStatus(msg);
  }

  await updateStatus(reply);

  if (statusMsgId && registerReply) {
    registerReply(statusMsgId, { author: senderID }, async ({ api, event }) => {
      await handle(api, event, event.body?.trim() || "", registerReply);
    });
  }

  await saveCtx(sessionKey, [
    ...ctx,
    { role: "user",      content: userContent },
    { role: "assistant", content: reply },
  ]);
}

module.exports = {
  config: {
    name: "groq",
    aliases: ["llma32", "ai2"],
    version: "10.0.0",
    author: "Sunken",
    countDown: 3,
    role: 0,
    shortDescription: { ar: "محادثة ذكية جماعية + Vision — Llama 4 Scout" },
    category: "ذكاء اصطناعي",
    guide: { ar: "{pn}ai2 [سؤالك]\n{pn}ai2 + صورة/صوت/فيديو\n{pn}ai2 مسح" },
  },

  onStart: async ({ api, event, args, message }) => {
    const prompt = args.join(" ").trim() || "";
    await handle(api, event, prompt, message?.registerReply);
  },

  onReply: async ({ api, event, message }) => {
    await handle(api, event, event.body?.trim() || "", message?.registerReply);
  },
};
