"use strict";

/**
 * أمر: mf
 * الاستخدام: mf <اسم المانجا>
 * مثال:      mf berserk
 *            mf one piece
 *
 * يبحث في MangaDex عن المانجا (بنفس منطق البحث والمطابقة المستخدم في
 * manga.js)، ثم يستخدم endpoint /manga/{id}/aggregate مفلترة بلغة
 * العربية فقط (translatedLanguage[]=ar) لجلب كل أرقام الفصول العربية
 * المتوفرة دفعة واحدة، ويحسب منها:
 *   - النطاقات المتتالية من الفصول المتوفرة فعليًا بالعربية
 *     (مثال: "من 1 الى 40 موجودة")
 *   - الفصول الناقصة (المفقودة) بين هذه النطاقات
 *
 * ملاحظة: الحساب يعتمد فقط على أرقام الفصول الصحيحة (أعداد كاملة)؛
 * الفصول الفرعية العشرية (13.5 مثلاً) لا تُحتسب كفجوة ولا كجزء من
 * نطاق، ويُتجاهل وجودها تمامًا عند حساب النطاقات/الفجوات.
 */

const axios = require("axios");
const cache = require("../utils/cache.js");

const API_BASE = "https://api.mangadex.org";
const SEARCH_TTL = 30 * 60 * 1000; // 30 دقيقة
const AGGREGATE_TTL = 15 * 60 * 1000; // 15 دقيقة
const MIN_MATCH_SCORE = 0.6;
const LANG = "ar"; // اللغة الوحيدة المدعومة الآن
const MAX_RUNS_SHOWN = 10; // أقصى عدد نطاقات "متوفرة" نعرضها بالتفصيل قبل التلخيص
const MAX_GAPS_SHOWN = 8; // أقصى عدد فجوات "مفقودة" نعرضها بالتفصيل قبل التلخيص

const HEADERS = { "User-Agent": "SunkenBot/2.0 (mf command)" };

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

// ─── جوهر الميزة: جلب نطاقات الفصول العربية المتوفرة ────────────

// يجلب aggregate مفلترة بالعربية فقط (translatedLanguage[]=ar)، فيرجع
// كل الفصول المترجمة للعربية تحديدًا (مجمّعة داخل مجلدات). نُرجع الـ
// volumes الخام لنعالجها لاحقًا.
async function fetchAggregate(mangaId) {
  const cacheKey = `manga_aggregate:${mangaId}:${LANG}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const res = await axios.get(`${API_BASE}/manga/${mangaId}/aggregate`, {
    params: { "translatedLanguage[]": [LANG] },
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

// يحسب النطاقات المتتالية المتوفرة والفجوات (الفصول الناقصة) بينها،
// بالاعتماد فقط على أرقام الفصول الصحيحة (أعداد كاملة). الفصول
// الفرعية العشرية (13.5 مثلاً) تُتجاهل تمامًا في هذا الحساب: لا تُحسب
// نطاقًا قائمًا بذاته ولا تسد فجوة.
function findRuns(numbers) {
  const ints = [...new Set(numbers.filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const runs = [];
  const gaps = [];
  if (!ints.length) return { runs, gaps };

  let start = ints[0];
  let prev = ints[0];
  for (let i = 1; i < ints.length; i++) {
    const cur = ints[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    runs.push({ from: start, to: prev });
    gaps.push({ from: prev + 1, to: cur - 1 });
    start = cur;
    prev = cur;
  }
  runs.push({ from: start, to: prev });

  return { runs, gaps };
}

function formatNumber(n) {
  return String(n);
}

function formatRuns(runs) {
  const shown = runs.slice(0, MAX_RUNS_SHOWN).map((r) =>
    r.from === r.to
      ? `الفصل ${formatNumber(r.from)} موجود`
      : `من ${formatNumber(r.from)} الى ${formatNumber(r.to)} موجودة`
  );
  let text = shown.join("\n");
  if (runs.length > MAX_RUNS_SHOWN) {
    text += `\n(و${runs.length - MAX_RUNS_SHOWN} نطاق آخر)`;
  }
  return text;
}

function formatMissing(gaps) {
  if (!gaps.length) return null;
  const shown = gaps.slice(0, MAX_GAPS_SHOWN).map((g) =>
    g.from === g.to ? `${formatNumber(g.from)}` : `${formatNumber(g.from)}-${formatNumber(g.to)}`
  );
  let text = shown.join("، ");
  if (gaps.length > MAX_GAPS_SHOWN) text += ` (و${gaps.length - MAX_GAPS_SHOWN} فجوة أخرى)`;
  return text;
}

module.exports = {
  config: {
    name: "mf",
    aliases: ["معلومات_مانجا", "نطاق_مانجا"],
    version: "2.0.0",
    author: "Sunken",
    countDown: 10,
    role: 0,
    shortDescription: { ar: "نطاق فصول المانجا المترجمة للعربية المتوفرة" },
    category: "media",
    guide: {
      ar:
        "{pn}mf [اسم المانجا]\n" +
        "أمثلة:\n" +
        "  {pn}mf berserk\n" +
        "  {pn}mf one piece\n" +
        "  {pn}mf attack on titan",
    },
  },

  onStart: async function ({ api, event, args }) {
    const { threadID, messageID } = event;

    if (!args.length) {
      return global.safeSend(
        api,
        "📖 نطاق فصول المانجا المترجمة للعربية\n\n" +
          "📝 الاستخدام: mf [اسم المانجا]\n\n" +
          "💡 مثال:\n  mf berserk\n  mf one piece",
        threadID,
        null,
        messageID
      );
    }

    const rawName = args.join(" ").trim();
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

      await updateStatus(`🔍 وجدت: ${mangaTitle}\n📄 جاري جلب الفصول المترجمة للعربية...`);

      let volumes;
      try {
        volumes = await fetchAggregate(mangaId);
      } catch (err) {
        throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
      }

      const numbers = extractChapterNumbers(volumes);
      if (!numbers.length) {
        throw { userMsg: "❌ لا توجد أي فصول مترجمة للعربية لهذه المانجا." };
      }

      numbers.sort((a, b) => a - b);
      const { runs, gaps } = findRuns(numbers);

      let msg = `مانجا ${mangaTitle} الفصول المترجمة للعربية المرفوعة :\n`;

      if (runs.length) {
        msg += formatRuns(runs);
        const missingText = formatMissing(gaps);
        if (missingText) msg += `\nالفصول المفقودة ${missingText}`;
      } else {
        // لا توجد فصول بأرقام صحيحة، فقط فصول فرعية/خاصة (عشرية)
        msg += `فصول خاصة فقط (${formatNumber(numbers[0])} - ${formatNumber(numbers[numbers.length - 1])})`;
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
