const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { translateToArabic } = require("../utils/translator.js");

// ─── رابط HF Space ────────────────────────────────────────────
// غيّر هذا لرابط الـ Space الخاص بك
const HF_API = process.env.HF_SPACE_URL || "https://YOUR-SPACE.hf.space";
const HF_TIMEOUT = 60000; // دقيقة كاملة (Playwright يحتاج وقت)

// ─── Cache ────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 3600 * 1000;
const CACHE_MAX = 100;

const cacheGet = (k) => {
  const i = cache.get(k);
  if (!i) return undefined;
  if (Date.now() > i.expires) { cache.delete(k); return undefined; }
  cache.delete(k); cache.set(k, i);
  return i.value;
};
const cacheSet = (k, v) => {
  if (cache.has(k)) cache.delete(k);
  cache.set(k, { value: v, expires: Date.now() + CACHE_TTL });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
};

// ─── المواقع المدعومة (للعرض فقط) ───────────────────────────
const JS_SITES = ["NovelHi", "WtrLab", "Freewebnovel"];

// تُرفع عندما يُرجع HF Space عدة نتائج متشابهة (need_selection)
// بدل تخمين أول نتيجة أو تجاهل الأمر — نعرضها كقائمة مرشحين على المستخدم
class NeedsSelectionError extends Error {
  constructor(candidates, site) {
    super(`اختيار مطلوب بين ${candidates.length} نتيجة محتملة`);
    this.candidates = candidates;
    this.site = site;
  }
}

// ─── ترجمة ────────────────────────────────────────────────────
function splitLongParagraph(p, maxLen) {
  if (p.length <= maxLen) return [p];
  const sentences = p.match(/[^.!?\u061f\u060c]+[.!?\u061f\u060c]*/g) || [p];
  const out = []; let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > maxLen && cur) { out.push(cur); cur = s; }
    else cur += s;
  }
  if (cur) out.push(cur);
  return out;
}

async function translateBatch(paragraphs) {
  if (!paragraphs?.length) return [];
  const arabicChars = paragraphs.join("").match(/[\u0600-\u06FF]/g);
  if (arabicChars && arabicChars.length > 50) return paragraphs;

  const MAX_CHUNK = 3800;
  const SEP = " ||| ";
  const safe = paragraphs.flatMap(p => splitLongParagraph(p, MAX_CHUNK));
  const chunks = []; let current = "";
  for (const p of safe) {
    const candidate = current ? current + SEP + p : p;
    if (candidate.length > MAX_CHUNK && current) { chunks.push(current); current = p; }
    else current = candidate;
  }
  if (current) chunks.push(current);

  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    try { out.push(await translateToArabic(chunks[i]) || chunks[i]); }
    catch { out.push(chunks[i]); }
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
  }
  const result = out.join(SEP).split("|||").map(p => p.trim()).filter(Boolean);
  return result.length > 0 ? result : paragraphs;
}

async function translateBatchCached(key, paragraphs) {
  const tKey = `translated:${key}`;
  const cached = cacheGet(tKey);
  if (cached) return cached;
  const translated = await translateBatch(paragraphs);
  cacheSet(tKey, translated);
  return translated;
}

// ─── الطلب لـ HF Space ────────────────────────────────────────
async function fetchFromHF(novelName, chapterNum, preferredSite = null, novelId = null) {
  const cacheKey = `hf:${novelName}:${chapterNum}:${preferredSite || "any"}:${novelId || "auto"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const body = { novel: novelName, chapter: chapterNum };
  if (preferredSite) body.site = preferredSite;
  if (novelId) body.novel_id = novelId;

  const res = await axios.post(`${HF_API}/novel`, body, {
    timeout: HF_TIMEOUT,
    headers: { "Content-Type": "application/json" },
    validateStatus: () => true,
  });

  if (res.status === 404) {
    const details = res.data?.details?.join("\n• ") || res.data?.error || "لا توجد تفاصيل";
    throw new Error(`لم يُعثر على الفصل:\n• ${details}`);
  }
  if (res.status === 200 && res.data?.need_selection) {
    // عدة نتائج متشابهة — لا نخمّن، نرفع خطأ خاص يحمل المرشحين
    throw new NeedsSelectionError(res.data.candidates || [], res.data.site || "");
  }
  if (res.status !== 200) {
    throw new Error(`HF API: خطأ ${res.status} — ${res.data?.error || "غير معروف"}`);
  }

  const data = res.data;
  if (!data.paragraphs?.length) throw new Error("HF API: المحتوى فارغ");

  const result = {
    title: data.title || novelName,
    chapterTitle: `الفصل ${chapterNum}`,
    paragraphs: data.paragraphs,
    url: data.url || "",
    siteName: data.site || "HF",
    wordCount: data.word_count || 0,
  };
  cacheSet(cacheKey, result);
  return result;
}

// ─── إرسال ────────────────────────────────────────────────────
const sendAsync = (api, body, tid, mid) =>
  new Promise((res, rej) => api.sendMessage(body, tid, (e, i) => e ? rej(e) : res(i), mid));

function splitMessage(text, maxLen = 8000) {
  const chunks = []; let cur = "";
  for (const para of text.split("\n\n")) {
    if ((cur + para + "\n\n").length > maxLen) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = para + "\n\n";
    } else cur += para + "\n\n";
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length > 0 ? chunks : [text];
}

async function sendAsFile(api, tid, mid, novelName, chapterNum, header, translated) {
  const content = header + translated.join("\n\n");
  const safe = novelName.replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "_") || "novel";
  const tmpPath = path.join(os.tmpdir(), `${safe}_Ch${chapterNum}.txt`);
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    await sendAsync(api,
      { body: `📖 الفصل ${chapterNum} كملف نصي`, attachment: fs.createReadStream(tmpPath) },
      tid, mid
    );
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// ─── module ───────────────────────────────────────────────────
module.exports = {
  config: {
    name: "novel2",
    aliases: ["رواية2", "nv2"],
    version: "1.0.0",
    author: "Sunken",
    countDown: 30,
    role: 0,
    shortDescription: { ar: "قراءة فصول حديثة من مواقع JS (NovelHi, WtrLab, Freewebnovel)" },
    category: "tools",
    guide: {
      ar: "{pn}novel2 [اسم الرواية] [رقم الفصل] [موقع (اختياري)]\n" +
          "أمثلة:\n" +
          "  .novel2 martial peak 3000\n" +
          "  .novel2 solo leveling 150 novelhi\n" +
          "  .novel2 shadow slave 13 freewebnovel\n\n" +
          "إذا ظهرت نتائج متشابهة، أعد الإرسال مع id:<الرقم> مثل:\n" +
          "  .novel2 martial peak 3000 id:12345"
    }
  },

  onStart: async function ({ api, event, args }) {
    const { threadID, messageID } = event;

    if (args.length < 2) {
      return api.sendMessage(
        "📚 قارئ الروايات (مواقع حديثة)\n\n" +
        "📝 الاستخدام:\n  .novel2 [اسم الرواية] [رقم الفصل]\n\n" +
        "💡 أمثلة:\n" +
        "  .novel2 martial peak 3000\n" +
        "  .novel2 solo leveling 150 novelhi\n" +
        "  .novel2 shadow slave 13 freewebnovel\n\n" +
        `🌐 المصادر: ${JS_SITES.join(", ")}\n\n` +
        "⚠️ قد يستغرق 30-60 ثانية (Playwright)\n" +
        "📨 يُرسل كرسائل + ملف .txt",
        threadID, null, messageID
      );
    }

    // تحليل الـ args: قد يحتوي على id:<رقم> (اختيار من قائمة مرشحين سابقة)
    // وآخر arg قد يكون اسم موقع، قبله رقم الفصل
    let args_copy = [...args];
    let novelId = null;

    const idIndex = args_copy.findIndex(a => /^id:\d+$/i.test(a));
    if (idIndex !== -1) {
      novelId = args_copy[idIndex].split(":")[1];
      args_copy.splice(idIndex, 1);
    }

    let preferredSite = null;

    const lastArg = args_copy[args_copy.length - 1].toLowerCase();
    if (JS_SITES.map(s => s.toLowerCase()).includes(lastArg)) {
      preferredSite = JS_SITES.find(s => s.toLowerCase() === lastArg);
      args_copy.pop();
    }

    const chArg = args_copy[args_copy.length - 1];
    if (isNaN(chArg) || Number(chArg) < 1) {
      return api.sendMessage(
        "❌ يجب أن يكون ما قبل اسم الموقع رقم الفصل\n💡 مثال: .novel2 martial peak 3000",
        threadID, null, messageID
      );
    }
    const chapterNum = parseInt(chArg);
    const novelName = args_copy.slice(0, -1).join(" ").trim();

    if (!novelName) {
      return api.sendMessage("❌ يجب كتابة اسم الرواية", threadID, null, messageID);
    }

    // رسالة الحالة
    let statusId = null;
    try {
      const sent = await sendAsync(api,
        `⏳ جلب الفصل عبر مواقع JS...\n📖 ${novelName}\n📄 الفصل ${chapterNum}` +
        (preferredSite ? `\n🌐 ${preferredSite}` : "") +
        `\n\n⚠️ قد يستغرق حتى 60 ثانية`,
        threadID, messageID
      );
      statusId = sent?.messageID;
    } catch (_) {}

    const updateStatus = async (text) => {
      try { if (statusId) await api.editMessage(text, statusId); } catch (_) {}
    };

    let result = null;
    try {
      await updateStatus(`🌐 Playwright يفتح الصفحة...\n📖 ${novelName}\n📄 الفصل ${chapterNum}`);
      result = await fetchFromHF(novelName, chapterNum, preferredSite, novelId);
      console.log(`[NOVEL2] ✅ ${result.siteName} نجح`);
    } catch (err) {
      if (err instanceof NeedsSelectionError) {
        const list = err.candidates
          .map((c, i) => `${i + 1}. ${c.title}\n   id:${c.id}`)
          .join("\n\n");
        const selectMsg =
          `🔎 وُجدت عدة نتائج متشابهة لـ "${novelName}" على ${err.site}:\n\n` +
          `${list}\n\n` +
          `💡 أعد إرسال الأمر مفرّقاً بإضافة id:<الرقم> في النهاية، مثال:\n` +
          `.novel2 ${novelName} ${chapterNum} id:${err.candidates[0]?.id || ""}`;
        try { if (statusId) await api.editMessage(selectMsg, statusId); else api.sendMessage(selectMsg, threadID, null, messageID); }
        catch (_) { api.sendMessage(selectMsg, threadID, null, messageID); }
        return;
      }
      console.warn(`[NOVEL2] فشل: ${err.message}`);
      const errMsg =
        `❌ لم أجد الفصل\n\n` +
        `📖 ${novelName} | 📄 الفصل ${chapterNum}\n\n` +
        `${err.message}\n\n` +
        `💡 تأكد من:\n• الاسم الإنجليزي الصحيح\n• رقم الفصل موجود في الموقع`;
      try { if (statusId) await api.editMessage(errMsg, statusId); else api.sendMessage(errMsg, threadID, null, messageID); }
      catch (_) { api.sendMessage(errMsg, threadID, null, messageID); }
      return;
    }

    await updateStatus(`🔄 ترجمة ${result.paragraphs.length} فقرة...\n📖 ${result.title}\n🌐 ${result.siteName}`);
    const cacheKey = `${result.siteName}:${novelName}:${chapterNum}`;
    const translated = await translateBatchCached(cacheKey, result.paragraphs);

    const divider = "─".repeat(35);
    const header = `📖 ${result.title}\n📄 ${result.chapterTitle}\n🌐 ${result.siteName}` +
      (result.wordCount ? ` (${result.wordCount} كلمة)` : "") +
      `\n${divider}\n\n`;

    try { if (statusId) await api.unsendMessage(statusId); } catch (_) {}

    // إرسال كرسالة واحدة أو مقطعة
    const fullText = header + translated.join("\n\n");
    try {
      await sendAsync(api, fullText, threadID, messageID);
    } catch (_) {
      const chunks = splitMessage(fullText);
      for (let i = 0; i < chunks.length; i++) {
        await new Promise(r => setTimeout(r, 800));
        const suffix = chunks.length > 1 ? `\n\n${divider}\n📌 ${i + 1} / ${chunks.length}` : "";
        await sendAsync(api, chunks[i] + suffix, threadID, messageID);
      }
    }

    // إرسال كملف
    try {
      await sendAsFile(api, threadID, messageID, novelName, chapterNum, header, translated);
    } catch (err) {
      api.sendMessage(`❌ فشل إرسال الملف: ${err.message}`, threadID, null, messageID);
    }
  }
};