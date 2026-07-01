"use strict";

/**
 * أمر: mangainfo
 * الاستخدام: mangainfo <اسم المانجا> [لغة اختيارية: ar/en/ja]
 * مثال:      mangainfo one piece
 *            mangainfo one piece en
 *
 * يبحث في MangaDex عن المانجا (بنفس منطق البحث والمطابقة المستخدم في
 * manga.js)، ثم يستخدم endpoint /manga/{id}/aggregate لجلب كل أرقام
 * الفصول المتوفرة بلغة معينة دفعة واحدة، ويحسب منها:
 *   - أحدث فصل متوفر
 *   - أقدم فصل متوفر (يكشف أن الفصول الأولى غير مرفوعة أحيانًا)
 *   - إجمالي عدد الفصول المتوفرة فعليًا بهذه اللغة
 *   - الفجوات (أرقام فصول مفقودة) داخل النطاق، إن وُجدت
 *
 * ملاحظة: على عكس manga.js الذي يتجنب /aggregate عمدًا (لأنه قد لا يُدرج
 * كل اللغات ضمن نفس رقم الفصل عند البحث عن نسخة واحدة)، هنا الاستخدام
 * مختلف تمامًا: نحن نطلب aggregate مفلترة بلغة واحدة محددة فقط
 * (translatedLanguage[]=lang)، وفي هذه الحالة الـ API يُرجع فعليًا كل
 * الفصول المترجمة لتلك اللغة تحديدًا، وهو بالضبط ما نحتاجه هنا.
 */

const axios = require("axios");
const cache = require("../utils/cache.js");

const API_BASE = "https://api.mangadex.org";
const SEARCH_TTL = 30 * 60 * 1000; // 30 دقيقة
const AGGREGATE_TTL = 15 * 60 * 1000; // 15 دقيقة
const MIN_MATCH_SCORE = 0.6;
const MAX_GAPS_SHOWN = 8; // أقصى عدد فجوات نعرضها بالتفصيل قبل التلخيص

const LANG_ALIASES = {
  ar: "ar", arabic: "ar", عربي: "ar", عربية: "ar",
  en: "en", eng: "en", english: "en", انجليزي: "en", إنجليزي: "en",
  ja: "ja", jp: "ja", japanese: "ja", ياباني: "ja",
};

const LANG_LABELS = { ar: "العربية", en: "الإنجليزية", ja: "اليابانية" };
const HEADERS = { "User-Agent": "SunkenBot/2.0 (mangainfo command)" };

// ─── أدوات مساعدة (نفس منطق manga.js) ─────────────────────────

function bigrams(str) {
  const s = str.toLowerCase().replace(/\s+/g, " ").trim();
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.substring(i, i + 2));
  return out;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  const bgA = bigrams(na);
  const bgB = bigrams(nb);
  if (!bgA.length || !bgB.length) return 0;
  const mapB = new Map();
  for (const bg of bgB) mapB.set(bg, (mapB.get(bg) || 0) + 1);
  let matches = 0;
  for (const bg of bgA) {
    const count = mapB.get(bg) || 0;
    if (count > 0) {
      matches++;
      mapB.set(bg, count - 1);
    }
  }
  return (2 * matches) / (bgA.length + bgB.length);
}

function cleanQuery(raw) {
  return raw
    .replace(/["'`ʼ’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function collectTitles(manga) {
  const titles = [];
  const attrs = manga.attributes || {};
  if (attrs.title) titles.push(...Object.values(attrs.title));
  if (Array.isArray(attrs.altTitles)) {
    for (const alt of attrs.altTitles) titles.push(...Object.values(alt));
  }
  return titles.filter(Boolean);
}

function bestTitle(manga) {
  const attrs = manga.attributes || {};
  return (
    attrs.title?.en ||
    attrs.title?.ja ||
    Object.values(attrs.title || {})[0] ||
    "بدون عنوان"
  );
}

async function searchManga(query) {
  const cacheKey = `manga_search:${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await axios.get(`${API_BASE}/manga`, {
    params: {
      title: query,
      limit: 20,
      "order[relevance]": "desc",
      "contentRating[]": ["safe", "suggestive", "erotica"],
    },
    headers: HEADERS,
    timeout: 15000,
  });

  const results = res.data?.data || [];
  cache.set(cacheKey, results, SEARCH_TTL);
  return results;
}

function pickBestManga(query, candidates) {
  let best = null;
  let bestScore = 0;
  for (const manga of candidates) {
    const titles = collectTitles(manga);
    let score = 0;
    for (const t of titles) score = Math.max(score, similarity(query, cleanQuery(t)));
    if (score > bestScore) {
      bestScore = score;
      best = manga;
    }
  }
  return { manga: best, score: bestScore };
}

// ─── جوهر الميزة: جلب نطاق الفصول المتوفرة بلغة معينة ───────────

// يجلب aggregate مفلترة بلغة واحدة فقط، فيرجع كل الفصول المترجمة لتلك
// اللغة (مجمّعة داخل مجلدات). نُرجع الـ volumes الخام لنعالجها لاحقًا.
async function fetchAggregate(mangaId, lang) {
  const cacheKey = `manga_aggregate:${mangaId}:${lang}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await axios.get(`${API_BASE}/manga/${mangaId}/aggregate`, {
    params: { "translatedLanguage[]": [lang] },
    headers: HEADERS,
    timeout: 15000,
  });

  const volumes = res.data?.volumes || {};
  cache.set(cacheKey, volumes, AGGREGATE_TTL);
  return volumes;
}

// يسحب كل أرقام الفصول (كأرقام) من بنية volumes المتشعبة، بغض النظر عن
// توزيعها على المجلدات (volumes)، بما فيها مجلد "none" (بلا مجلد).
function extractChapterNumbers(volumes) {
  const numbers = [];
  for (const volKey of Object.keys(volumes || {})) {
    const chapters = volumes[volKey]?.chapters || {};
    for (const chKey of Object.keys(chapters)) {
      const n = Number(chapters[chKey]?.chapter);
      if (!Number.isNaN(n)) numbers.push(n);
    }
  }
  return numbers;
}

// يكتشف الفجوات في الفصول الصحيحة (أعداد كاملة) فقط بين أصغر وأكبر رقم،
// متجاهلًا الفصول الفرعية العشرية (13.5 مثلاً) التي لا تُعتبر فجوة.
function findGaps(numbers) {
  const ints = [...new Set(numbers.filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ints.length; i++) {
    const diff = ints[i] - ints[i - 1];
    if (diff > 1) gaps.push({ from: ints[i - 1] + 1, to: ints[i] - 1 });
  }
  return gaps;
}

function formatNumber(n) {
  return Number.isInteger(n) ? String(n) : String(n);
}

function formatGaps(gaps) {
  if (!gaps.length) return null;
  const shown = gaps.slice(0, MAX_GAPS_SHOWN).map((g) =>
    g.from === g.to ? `${g.from}` : `${g.from}-${g.to}`
  );
  let text = shown.join("، ");
  if (gaps.length > MAX_GAPS_SHOWN) text += ` (و${gaps.length - MAX_GAPS_SHOWN} فجوة أخرى)`;
  return text;
}

module.exports = {
  config: {
    name: "mangainfo",
    aliases: ["معلومات_مانجا", "نطاق_مانجا"],
    version: "1.0.0",
    author: "Sunken",
    countDown: 10,
    role: 0,
    shortDescription: { ar: "نطاق الفصول المتوفرة لمانجا بلغة معينة" },
    category: "media",
    guide: {
      ar:
        "{pn}mangainfo [اسم المانجا] [لغة اختيارية]\n" +
        "أمثلة:\n" +
        "  {pn}mangainfo one piece\n" +
        "  {pn}mangainfo one piece en\n" +
        "  {pn}mangainfo attack on titan ar",
    },
  },

  onStart: async function ({ api, event, args }) {
    const { threadID, messageID } = event;

    if (!args.length) {
      return global.safeSend(
        api,
        "📖 معلومات نطاق المانجا\n\n" +
          "📝 الاستخدام: mangainfo [اسم المانجا] [لغة اختيارية]\n\n" +
          "💡 مثال:\n  mangainfo one piece\n  mangainfo one piece en",
        threadID,
        null,
        messageID
      );
    }

    // استخراج لغة اختيارية من آخر كلمة، وإلا نفترض العربية افتراضيًا
    let workingArgs = [...args];
    let lang = "ar";
    if (workingArgs.length >= 2) {
      const maybeLang = LANG_ALIASES[workingArgs[workingArgs.length - 1].toLowerCase()];
      if (maybeLang) {
        lang = maybeLang;
        workingArgs = workingArgs.slice(0, -1);
      }
    }

    const rawName = workingArgs.join(" ").trim();
    const mangaQuery = cleanQuery(rawName);
    if (!mangaQuery) {
      return global.safeSend(api, "❗ يرجى تحديد اسم المانجا.", threadID, null, messageID);
    }

    let statusMsgId = null;
    try {
      // نستخدم الـ callback لالتقاط messageID الرسالة المُرسلة، لأن
      // القيمة التي تُرجعها global.safeSend نفسها لا تحمل هذه المعلومة
      // (تُحلّ الـ Promise بمجرد استدعاء sendMessage، لا بعد اكتمال الإرسال)
      statusMsgId = await new Promise((resolve) => {
        global.safeSend(
          api,
          `⏳ جاري البحث عن المانجا...\n📖 ${rawName}`,
          threadID,
          (err, info) => resolve(err ? null : info?.messageID || null),
          messageID
        );
      });
    } catch (_) {}

    const updateStatus = async (text) => {
      try {
        if (statusMsgId) await api.editMessage(text, statusMsgId);
        else global.safeSend(api, text, threadID, null, messageID);
      } catch (_) {
        global.safeSend(api, text, threadID, null, messageID);
      }
    };

    try {
      let candidates;
      try {
        candidates = await searchManga(mangaQuery);
      } catch (err) {
        throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
      }

      if (!candidates.length) {
        throw { userMsg: "❌ لم يتم العثور على مانجا بهذا الاسم." };
      }

      const { manga, score } = pickBestManga(mangaQuery, candidates);
      if (!manga || score < MIN_MATCH_SCORE) {
        throw { userMsg: "❌ لم أتمكن من العثور على المانجا." };
      }

      const mangaId = manga.id;
      const mangaTitle = bestTitle(manga);
      const langLabel = LANG_LABELS[lang] || lang;

      await updateStatus(`🔍 وجدت: ${mangaTitle}\n📄 جاري جلب نطاق الفصول بـ${langLabel}...`);

      let volumes;
      try {
        volumes = await fetchAggregate(mangaId, lang);
      } catch (err) {
        throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
      }

      const numbers = extractChapterNumbers(volumes);
      if (!numbers.length) {
        throw { userMsg: `❌ لا توجد أي فصول مترجمة بـ${langLabel} لهذه المانجا.` };
      }

      numbers.sort((a, b) => a - b);
      const min = numbers[0];
      const max = numbers[numbers.length - 1];
      const total = new Set(numbers).size;
      const gaps = findGaps(numbers);

      let msg =
        `📖 ${mangaTitle}\n` +
        `🌐 اللغة: ${langLabel}\n` +
        `📄 النطاق: من الفصل ${formatNumber(min)} إلى الفصل ${formatNumber(max)}\n` +
        `🔢 عدد الفصول المتوفرة فعليًا: ${total}`;

      const gapsText = formatGaps(gaps);
      if (gapsText) {
        msg += `\n⚠️ فصول ناقصة داخل النطاق: ${gapsText}`;
      }

      await updateStatus(msg);
    } catch (err) {
      const userMsg = err?.userMsg || `❌ حدث خطأ غير متوقع: ${err?.message?.substring(0, 80) || ""}`;
      try {
        if (statusMsgId) await api.editMessage(userMsg, statusMsgId);
        else global.safeSend(api, userMsg, threadID, null, messageID);
      } catch (_) {
        global.safeSend(api, userMsg, threadID, null, messageID);
      }
    }
  },
};
