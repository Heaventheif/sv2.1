"use strict";

/**
 * أمر: manga
 * الاستخدام: manga <اسم المانجا> <رقم الفصل> [لغة اختيارية: ar/en/ja]
 * مثال:      manga one piece 13
 *            manga one piece 13 en
 *
 * يبحث في MangaDex عن المانجا، يحدد أفضل نتيجة مطابقة، يجلب الفصل
 * المطلوب (بأولوية لغة عربي > إنجليزي > ياباني > أي لغة متاحة)،
 * ثم يرسل جميع صفحاته كصور دفعات (10 لكل دفعة).
 */

const axios   = require("axios");
const fs      = require("fs-extra");
const os      = require("os");
const path    = require("path");
const cache   = require("../utils/cache.js");

const API_BASE       = "https://api.mangadex.org";
const MAX_PER_GROUP  = 10;               // حد الصور لكل دفعة إرسال
const SEARCH_TTL     = 30 * 60 * 1000;   // 30 دقيقة
const AGGREGATE_TTL  = 10 * 60 * 1000;   // 10 دقائق
const MIN_MATCH_SCORE = 0.60;            // أدنى نسبة تشابه مقبولة

// أولوية اللغات عند عدم تحديد المستخدم للغة
const LANG_PRIORITY = ["ar", "en", "ja"];

// اختصارات لغة قد يكتبها المستخدم في نهاية الأمر
const LANG_ALIASES = {
  ar: "ar", arabic: "ar", عربي: "ar", عربية: "ar",
  en: "en", eng: "en", english: "en", انجليزي: "en", إنجليزي: "en",
  ja: "ja", jp: "ja", japanese: "ja", ياباني: "ja",
};

const LANG_LABELS = { ar: "العربية", en: "الإنجليزية", ja: "اليابانية" };

const HEADERS = { "User-Agent": "SunkenBot/2.0 (manga command)" };

// ─── أدوات مساعدة عامة ─────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// تحويل نص إلى ثنائيات حروف (bigrams) لحساب التشابه
function bigrams(str) {
  const s = str.toLowerCase().replace(/\s+/g, " ").trim();
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.substring(i, i + 2));
  return out;
}

// نسبة تشابه (Dice's Coefficient) بين نصين — بديل مبسّط لمكتبة string-similarity
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

// تنظيف اسم المانجا المُدخل من المستخدم
function cleanQuery(raw) {
  return raw
    .replace(/["'`ʼ’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// جلب كل عناوين المانجا (الرئيسي + البدائل) كمصفوفة نصوص
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

// ─── المرحلة الرابعة/الخامسة/السادسة: البحث واختيار أفضل نتيجة ───

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

// ─── المرحلة السابعة/الثامنة: البحث المباشر عن الفصل عبر /chapter ───
//
// لم نعد نعتمد على /manga/{id}/aggregate إطلاقًا لاختيار نسخة اللغة، لأن
// aggregate يجمّع الفصول بطريقة قد لا تُدرج كل اللغات ضمن id/others لنفس
// رقم الفصل (وهذا كان سبب اختيار الإسبانية رغم توفر العربية). البديل هنا:
// استعلام مباشر لـ /chapter بفلاتر manga + chapter + translatedLanguage،
// ثم فلترة/ترتيب النتائج يدويًا لاختيار أدق نسخة.

const CHAPTER_FETCH_LIMIT = 100; // نجلب كل النسخ المتاحة بنفس الرقم/اللغة دفعة واحدة بدل limit=1
const CHAPTER_QUERY_TTL   = 5 * 60 * 1000; // كاش قصير لاستعلامات الفصل (5 دقائق)

// يبني صيغ محتملة لرقم الفصل كما قد يُخزَّن في MangaDex:
// "13" يجب أن يقبل أيضًا "13.0"، والعكس، لكن لا يقبل "130" أو "213".
// نعتمد على صيغتين فقط (بدون/مع ".0") تغطي الغالبية العظمى من الحالات،
// وأي مطابقة نهائية تُتحقق عدديًا لاحقًا في isExactChapterMatch() كحارس أمان إضافي.
function buildChapterCandidates(chapterNumberStr) {
  const raw = String(chapterNumberStr).trim();
  const candidates = new Set([raw]);

  if (!raw.includes(".")) {
    candidates.add(`${raw}.0`);
  } else if (raw.endsWith(".0")) {
    candidates.add(raw.slice(0, -2));
  }

  return [...candidates];
}

// مطابقة عددية صارمة: 13 يساوي 13.0 لكنه لا يساوي 130 أو 213.
// هذا يحل محل أي استخدام لـ includes()/parseFloat() التقريبي في المنطق القديم.
function isExactChapterMatch(attrChapter, targetNum) {
  if (attrChapter === null || attrChapter === undefined) return false;
  const n = Number(attrChapter);
  return !Number.isNaN(n) && n === targetNum;
}

// يستبعد النتائج غير الصالحة للقراءة داخل البوت:
// - فصول خارجية (externalUrl): لا تحتوي صفحات قابلة للتحميل من MangaDex.
// - فصول بلا صفحات (pages === 0): غالبًا محذوفة أو منسوخة جزئيًا.
function isReadableChapter(attrs) {
  if (!attrs) return false;
  if (attrs.externalUrl) return false;
  if (typeof attrs.pages === "number" && attrs.pages <= 0) return false;
  return true;
}

// من بين نتائج /chapter الخام لنفس رقم/لغة الفصل، يختار الأنسب:
// تطابق عددي دقيق + قابل للقراءة + الأحدث (readableAt) عند تعدد الترجمات.
function pickBestChapterResult(rawResults, targetNum) {
  const valid = (rawResults || []).filter(
    (item) => item?.attributes && isExactChapterMatch(item.attributes.chapter, targetNum) && isReadableChapter(item.attributes)
  );
  if (!valid.length) return null;

  valid.sort((a, b) => {
    const da = new Date(a.attributes.readableAt || a.attributes.publishAt || 0).getTime();
    const db = new Date(b.attributes.readableAt || b.attributes.publishAt || 0).getTime();
    return db - da; // الأحدث أولاً
  });

  const best = valid[0];
  return { id: best.id, lang: best.attributes.translatedLanguage };
}

// استعلام خام واحد إلى /chapter بفلتر رقم فصل معيّن (+لغة اختيارية)
async function queryChaptersRaw(mangaId, chapterFilter, lang) {
  const cacheKey = `manga_chapter_query:${mangaId}:${chapterFilter}:${lang || "any"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const params = {
    manga: mangaId,
    chapter: chapterFilter,
    limit: CHAPTER_FETCH_LIMIT,
    "order[readableAt]": "desc",
    "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
  };
  if (lang) params["translatedLanguage[]"] = [lang];

  const res = await axios.get(`${API_BASE}/chapter`, {
    params,
    headers: HEADERS,
    timeout: 15000,
  });

  const data = Array.isArray(res.data?.data) ? res.data.data : [];
  cache.set(cacheKey, data, CHAPTER_QUERY_TTL);
  return data;
}

// يجرّب كل صيغ رقم الفصل المحتملة (13 / 13.0) للغة واحدة، ويدمج النتائج
// قبل اختيار الأفضل. هذا يغطي طلب "لا تستخدم limit=1، اجمع النتائج ثم اختر".
async function findBestChapterForLanguage(mangaId, chapterCandidates, lang, targetNum) {
  const combined = [];
  for (const candidate of chapterCandidates) {
    try {
      const results = await queryChaptersRaw(mangaId, candidate, lang);
      if (results.length) combined.push(...results);
    } catch (_) {
      /* تجاهل فشل صيغة واحدة، جرّب الصيغة التالية */
    }
  }
  return pickBestChapterResult(combined, targetNum);
}

// الملاذ الأخير عند عدم توفر رقم الفصل بأي من الصيغ ولا بأي لغة من الأولوية:
// نجلب أقرب فصل رقميًا (فرق مطلق أصغر) من نفس المانجا، مهما كانت لغته،
// حتى لا يفشل الأمر كليًا إن كان الفصل مرقّمًا بصيغة غير متوقعة (مثل "13-omake").
// يُستخدم فقط إذا لم توجد أي نتيجة أخرى مطابقة تمامًا (وفق الشرط رقم 7).
async function findNearestChapterAsLastResort(mangaId, targetNum) {
  try {
    const res = await axios.get(`${API_BASE}/chapter`, {
      params: {
        manga: mangaId,
        limit: CHAPTER_FETCH_LIMIT,
        "order[chapter]": "asc",
        "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
      },
      headers: HEADERS,
      timeout: 15000,
    });

    const data = Array.isArray(res.data?.data) ? res.data.data : [];
    const readable = data.filter((item) => isReadableChapter(item?.attributes));
    if (!readable.length) return null;

    let nearest = null;
    let nearestDiff = Infinity;
    for (const item of readable) {
      const n = Number(item.attributes.chapter);
      if (Number.isNaN(n)) continue;
      const diff = Math.abs(n - targetNum);
      if (diff < nearestDiff) {
        nearestDiff = diff;
        nearest = item;
      }
    }
    if (!nearest) return null;
    return { id: nearest.id, lang: nearest.attributes.translatedLanguage };
  } catch (_) {
    return null;
  }
}

// نقطة الدخول الرئيسية لاختيار الفصل واللغة الصحيحين.
// عربي فقط دائمًا (ما لم يحدد المستخدم لغة أخرى صراحةً) — بدون أي رجوع
// تلقائي للغة بديلة (إسبانية أو غيرها) وبدون ملاذ أخير بأقرب رقم فصل.
// إن لم يتوفر الفصل باللغة المطلوبة، تُرجَع النتيجة فارغة والمستدعي يبلّغ
// المستخدم أن الفصل غير متوفر بتلك اللغة تحديدًا.
async function resolveChapter(mangaId, chapterNumberStr, requestedLang) {
  const targetNum = Number(chapterNumberStr);
  const chapterCandidates = buildChapterCandidates(chapterNumberStr);
  const lang = requestedLang || "ar";

  const selected = await findBestChapterForLanguage(mangaId, chapterCandidates, lang, targetNum);

  console.log({
    mangaId,
    chapter: chapterNumberStr,
    requestedLanguage: lang,
    selectedLanguage: selected?.lang || null,
    chapterId: selected?.id || null,
  });

  if (selected) {
    return { chapterId: selected.id, lang: selected.lang, availableLangs: [selected.lang] };
  }

  return { chapterId: null, availableLangs: [] };
}

// ─── المرحلة الحادية عشر/الثانية عشر: At-Home Server وبناء الروابط ───

async function buildPageUrls(chapterId) {
  const res = await axios.get(`${API_BASE}/at-home/server/${chapterId}`, {
    headers: HEADERS,
    timeout: 15000,
  });

  const baseUrl = res.data?.baseUrl;
  const chapter = res.data?.chapter;
  if (!baseUrl || !chapter?.hash || !Array.isArray(chapter.data)) return [];

  return chapter.data.map((file) => `${baseUrl}/data/${chapter.hash}/${file}`);
}

// ─── المرحلة الرابعة عشر: تحميل وإرسال الصور على دفعات ───

async function downloadImage(url, index) {
  const ext = path.extname(url).split("?")[0] || ".jpg";
  const filePath = path.join(os.tmpdir(), `manga_${Date.now()}_${index}${ext}`);
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    headers: HEADERS,
  });
  await fs.writeFile(filePath, res.data);
  return filePath;
}

module.exports = {
  config: {
    name: "manga",
    aliases: ["مانجا"],
    version: "1.0.0",
    author: "Sunken",
    countDown: 15,
    role: 0,
    shortDescription: { ar: "قراءة فصول المانجا (صور)" },
    category: "media",
    guide: {
      ar:
        "{pn}manga [اسم المانجا] [رقم الفصل] [لغة اختيارية]\n" +
        "أمثلة:\n" +
        "  {pn}manga one piece 13\n" +
        "  {pn}manga one piece 13 en\n" +
        "  {pn}manga attack on titan 5 ar",
    },
  },

  onStart: async function ({ api, event, args }) {
    const { threadID, messageID } = event;

    // ─── المرحلة الثانية: تحليل الأمر ───
    if (!args.length) {
      return global.safeSend(
        api,
        "📖 قارئ المانجا\n\n" +
          "📝 الاستخدام: manga [اسم المانجا] [رقم الفصل]\n\n" +
          "💡 مثال:\n  manga one piece 13\n  manga one piece 13 en",
        threadID,
        null,
        messageID
      );
    }

    // استخراج لغة اختيارية من آخر كلمة (ar/en/ja...)
    let workingArgs = [...args];
    let requestedLang = null;
    if (workingArgs.length >= 3) {
      const maybeLang = LANG_ALIASES[workingArgs[workingArgs.length - 1].toLowerCase()];
      if (maybeLang) {
        requestedLang = maybeLang;
        workingArgs = workingArgs.slice(0, -1);
      }
    }

    const lastToken = workingArgs[workingArgs.length - 1];
    const isChapterNumber = lastToken && /^\d+(\.\d+)?$/.test(lastToken);

    if (!isChapterNumber) {
      return global.safeSend(api, "❗ يرجى تحديد رقم الفصل.", threadID, null, messageID);
    }

    const chapterNumber = lastToken;
    const rawName = workingArgs.slice(0, -1).join(" ").trim();

    if (!rawName) {
      return global.safeSend(
        api,
        "📖 قارئ المانجا\n\n" +
          "📝 الاستخدام: manga [اسم المانجا] [رقم الفصل]\n\n" +
          "💡 مثال:\n  manga one piece 13",
        threadID,
        null,
        messageID
      );
    }

    // ─── المرحلة الثالثة: تنظيف البيانات ───
    const mangaQuery = cleanQuery(rawName);
    if (!mangaQuery) {
      return global.safeSend(api, "❗ يرجى تحديد رقم الفصل.", threadID, null, messageID);
    }

    let statusMsgId = null;
    try {
      const sent = await global.safeSend(
        api,
        `⏳ جاري البحث عن المانجا...\n📖 ${rawName}\n📄 الفصل ${chapterNumber}`,
        threadID,
        null,
        messageID
      );
      statusMsgId = sent?.messageID;
    } catch (_) {}

    const updateStatus = async (text) => {
      try {
        if (statusMsgId) await api.editMessage(text, statusMsgId);
      } catch (_) {}
    };

    try {
      // ─── المرحلة الرابعة/الخامسة/السادسة ───
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

      await updateStatus(`🔍 وجدت: ${mangaTitle}\n📄 جاري البحث عن الفصل ${chapterNumber}...`);

      // ─── المرحلة السابعة إلى العاشرة: البحث عن الفصل واختيار اللغة ───
      let chapterId, lang, availableLangs;
      try {
        ({ chapterId, lang, availableLangs } = await resolveChapter(
          mangaId,
          chapterNumber,
          requestedLang
        ));
      } catch (err) {
        throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
      }

      if (!chapterId) {
        const langLabel = LANG_LABELS[requestedLang || "ar"] || requestedLang;
        throw { userMsg: `❌ الفصل ${chapterNumber} غير متوفر بـ${langLabel}.` };
      }

      await updateStatus(`📥 جاري تجهيز صفحات الفصل ${chapterNumber}...\n📖 ${mangaTitle}`);

      // ─── المرحلة الحادية عشر/الثانية عشر: At-Home Server وبناء الروابط ───
      let pageUrls;
      try {
        pageUrls = await buildPageUrls(chapterId);
      } catch (err) {
        throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
      }

      // ─── المرحلة الثالثة عشر: التحقق من الصور ───
      if (!pageUrls.length) {
        throw { userMsg: "❌ الفصل لا يحتوي على صفحات." };
      }

      await updateStatus(
        `📥 جاري تحميل ${pageUrls.length} صفحة...\n📖 ${mangaTitle}\n📄 الفصل ${chapterNumber}`
      );

      // تحميل جميع الصور (محاولات مستقلة، فشل صورة لا يوقف الباقي)
      const downloaded = new Array(pageUrls.length).fill(null);
      await Promise.allSettled(
        pageUrls.map(async (url, i) => {
          try {
            downloaded[i] = await downloadImage(url, i);
          } catch (_) {
            downloaded[i] = null;
          }
        })
      );

      const validFiles = downloaded.filter(Boolean);
      if (!validFiles.length) {
        throw { userMsg: "❌ فشل تحميل صفحات الفصل. حاول مرة أخرى." };
      }

      try {
        if (statusMsgId) await api.unsendMessage(statusMsgId, threadID);
      } catch (_) {}

      // ─── المرحلة الرابعة عشر: إرسال الصور على دفعات ───
      let allSent = true;
      const totalGroups = Math.ceil(validFiles.length / MAX_PER_GROUP);
      for (let i = 0; i < validFiles.length; i += MAX_PER_GROUP) {
        const group = validFiles.slice(i, i + MAX_PER_GROUP);
        const groupNum = Math.floor(i / MAX_PER_GROUP) + 1;
        const isFirst = i === 0;

        const body =
          totalGroups > 1
            ? `📖 ${mangaTitle} — الفصل ${chapterNumber} (${groupNum}/${totalGroups})`
            : `📖 ${mangaTitle} — الفصل ${chapterNumber}`;

        try {
          await global.safeSend(
            api,
            { body, attachment: group.map((f) => fs.createReadStream(f)) },
            threadID,
            null,
            isFirst ? messageID : null
          );
        } catch (err) {
          allSent = false;
        }
        if (i + MAX_PER_GROUP < validFiles.length) await sleep(600);
      }

      await Promise.allSettled(validFiles.map((f) => fs.remove(f)));

      // ─── المرحلة الخامسة عشر: رسالة النهاية ───
      if (allSent && validFiles.length === pageUrls.length) {
        global.safeSend(api, "✅ تم إرسال الفصل بالكامل.\nاستمتع بالقراءة. 📚", threadID, null, null);
      } else {
        global.safeSend(
          api,
          "⚠️ تم إرسال جزء من الفصل.\nيمكنك إعادة المحاولة.",
          threadID,
          null,
          null
        );
      }
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
