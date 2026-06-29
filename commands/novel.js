const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { translateToArabic } = require("../utils/translator.js");

const cache = new Map();
const CACHE_TTL = 3600 * 1000;
const CACHE_MAX_ENTRIES = 150; // حد أقصى لعدد العناصر المخزنة لمنع امتلاء الذاكرة

const cacheGet = (k) => {
  const i = cache.get(k);
  if (!i) return undefined;
  if (Date.now() > i.expires) { cache.delete(k); return undefined; }
  // إعادة إدراج العنصر في آخر الـ Map يجعله "الأحدث استخدامًا" (LRU)
  cache.delete(k);
  cache.set(k, i);
  return i.value;
};

const cacheSet = (k, v) => {
  if (cache.has(k)) cache.delete(k);
  cache.set(k, { value: v, expires: Date.now() + CACHE_TTL });
  // إذا تجاوز العدد الحد المسموح، حذف الأقدم (أول عنصر في الـ Map)
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
};

if (!global.__novelCacheCleanupRegistered) {
  global.__novelCacheCleanupRegistered = true;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now > v.expires) cache.delete(k);
    }
  }, CACHE_TTL);
}

// قائمة User-Agents حديثة يتم التدوير بينها عشوائيًا في كل طلب
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/125.0.0.0 Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const BROWSER_HEADERS = () => ({
  "User-Agent": randomUA(),
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
});

const FALLBACK_SITES = [
  {
    name: "AllNovelFull",
    buildUrl: (slug, ch) => `https://allnovelfull.net/${slug}/chapter-${ch}.html`,
    selectors: ["#chapter-content", ".chapter-content", ".text-content"],
    titleSel: [".truyen-title", "h3.title", "title"],
    slugify: (n) => n.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    buildChapter: (ch) => String(ch),
  },
  {
    // NovelFull: يكتب عنوان الفصل في الرابط أيضاً مثل:
    // /kingdoms-bloodline/chapter-100-ramon-one.html
    // لذا نجلب صفحة الفهرس ونبحث فيها عن رابط الفصل الصحيح
    name: "NovelFull",
    indexUrl: (slug) => `https://novelfull.com/${slug}.html`,
    selectors: ["#chapter-content", ".chapter-content", ".text-left"],
    titleSel: [".truyen-title", "h3.title", "title"],
    slugify: (n) => n.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    buildChapter: (ch) => String(ch),
  },
  {
    // NovelFire: المسار الصحيح /book/ وليس /novel/
    name: "NovelFire",
    buildUrl: (slug, ch) => `https://novelfire.net/book/${slug}/chapter-${ch}`,
    selectors: [
      ".chapter-content", "#chapter-content",
      "div.content", ".reading-content",
      "div[class*='chapter']", "article",
    ],
    titleSel: [".novel-title", "h1", "title"],
    slugify: (n) => n.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    buildChapter: (ch) => String(ch),
  },
  // ─── المواقع الجديدة ───────────────────────────────────────────
  {
    // INovelHub: https://inovelhub.com/novel/{slug}/chapter-{ch}
    name: "INovelHub",
    buildUrl: (slug, ch) => `https://inovelhub.com/novel/${slug}/chapter-${ch}`,
    selectors: [
      "div#chapter-content", "#chapter-content",
      ".chapter-content", ".entry-content",
      "div[id*='chapter']", "div[class*='chapter']",
      "article .content", "main article",
    ],
    titleSel: [".novel-title", "h1", "title"],
    slugify: (n) => n.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    buildChapter: (ch) => String(ch),
  },
  {
    // NovelCrest: بعض الروايات لها لاحقة -2 في الرابط
    name: "NovelCrest",
    buildUrl: (slug, ch) => `https://www.novelcrest.com/book/${slug}/${ch}.html`,
    buildUrlAlt: (slug, ch) => `https://www.novelcrest.com/book/${slug}-2/${ch}.html`,
    selectors: ["div#chr-content", ".chr-c", "#chr-content"],
    titleSel: [".chr-title", "h1", "title"],
    slugify: (n) => n.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    buildChapter: (ch) => String(ch),
  },
];

// ─── موقع احتياطي (Fallback) فقط ─────────────────────────────
// WuxiaBox سريع جدًا لكن جودة ترجمته/نصه الأصلي ضعيفة، لذا لا يُستخدم
// إلا إذا فشلت جميع المواقع الأساسية أعلاه
const WUXIABOX_SITE = {
  // WuxiaBox: يستخدم رقم ID داخلي للرواية (مثل 6926877) وليس slug نصي
  name: "WuxiaBox",
  buildUrl: (novelID, ch) => `https://www.wuxiabox.com/novel/${novelID}_${ch}.html`,
  selectors: ["article#chapter-article", "div.chapter-content", ".page-in"],
  titleSel: [".truyen-title", "h1", "title"],
  slugify: (n) => n,
  buildChapter: (ch) => String(ch),
};

const PROXIES = [
  { build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, successCount: 0 },
  { build: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`, successCount: 0 },
];
// ترتيب البروكسيات تنازليًا بحسب عدد مرات نجاحها، فالأنجح يُجرَّب أولًا في كل مرة
const orderedProxies = () => [...PROXIES].sort((a, b) => b.successCount - a.successCount);

const FILTER_WORDS = [
  "novelfull.com", "boxnovel", "novelmt.com", "mtlnovel.me",
  "advertisement", "report chapter", "next chapter", "prev chapter",
  "table of contents", "access denied", "just a moment", "cloudflare",
  "enable javascript", "read more at",
];

// أنماط جمل "الحماية من السرقة" التي تُدرج وسط الفقرات في مواقع كثيرة
// (تُكتب بصيغ متعددة لكنها تدور حول نفس المعنى: "إذا كنت تقرأ هذا في موقع آخر فهو مسروق")
const STOLEN_CONTENT_PATTERNS = [
  /stol(en|e)\s+(content|chapter|novel)/i,
  /(this|the)\s+(chapter|content|novel)\s+(is|was)\s+stolen/i,
  /if\s+you('| a)re\s+reading\s+this\s+on/i,
  /please\s+read\s+(this|it)\s+on\s+(the\s+)?original/i,
  /unauthorized\s+(use|reproduction|copy)/i,
  /support\s+the\s+(author|translator)\s+by\s+reading/i,
];

const isFiltered = (t) => {
  const lower = t.toLowerCase();
  if (FILTER_WORDS.some(w => lower.includes(w))) return true;
  if (STOLEN_CONTENT_PATTERNS.some(re => re.test(t))) return true;
  return false;
};

// تطبيع الرموز الغريبة التي تضعها بعض المواقع لتشتيت أدوات الكشط
// (نقاط/أقواس متكررة، مسافات غير منتظمة) قبل إرسال النص للترجمة
function cleanText(t) {
  return t
    .replace(/\u00a0/g, " ")           // مسافات غير منقطعة (nbsp)
    .replace(/[•◆▪]{2,}/g, " ")        // رموز تزيينية متكررة
    .replace(/\.{4,}/g, "...")         // نقاط متتالية مفرطة
    .replace(/\s{2,}/g, " ")           // مسافات متعددة
    .trim();
}

// ─── تحويل دوال الـ callback لـ Promise (لتقليل التكرار) ─────
const sendMessageAsync = (api, body, threadID, messageID) =>
  new Promise((resolve, reject) =>
    api.sendMessage(body, threadID, (err, info) => (err ? reject(err) : resolve(info)), messageID)
  );

// ─── سباق سريع: أول نتيجة ناجحة تكسب (بدل التسلسل) ────────────
async function raceFirstSuccess(tasks) {
  return new Promise((resolve, reject) => {
    let pending = tasks.length;
    const errors = [];
    if (pending === 0) return reject(new Error("لا توجد مصادر متاحة"));
    tasks.forEach((task) => {
      task.promise
        .then((value) => resolve({ value, siteName: task.siteName }))
        .catch((err) => {
          errors.push(`${task.siteName}: ${err.message?.substring(0, 60)}`);
          pending -= 1;
          if (pending === 0) reject(new Error(errors.join(" | ")));
        });
    });
  });
}

// تقسيم فقرة مفردة طويلة جدًا (حالة نادرة) عند حدود الجملة بدل قطع الحروف عشوائيًا
function splitLongParagraph(p, maxLen) {
  if (p.length <= maxLen) return [p];
  const sentences = p.match(/[^.!?\u061f\u060c]+[.!?\u061f\u060c]*/g) || [p];
  const out = [];
  let cur = "";
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
  // كل فقرة تُقسَّم أولًا عند حدود الجملة إذا كانت أطول من حد الحزمة بمفردها
  const safeParagraphs = paragraphs.flatMap(p => splitLongParagraph(p, MAX_CHUNK));

  const chunks = [];
  let current = "";
  for (const p of safeParagraphs) {
    const candidate = current ? current + SEP + p : p;
    if (candidate.length > MAX_CHUNK && current) { chunks.push(current); current = p; }
    else current = candidate;
  }
  if (current) chunks.push(current);

  console.log(`[TRANSLATE] ${paragraphs.length} فقرة → ${chunks.length} chunk`);

  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const translated = await translateToArabic(chunks[i]);
      out.push(translated || chunks[i]);
    } catch { out.push(chunks[i]); }
    // تأخير عشوائي بين 300-700ms بين الطلبات لتقليل احتمال تقييد المعدل (rate limiting)
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
  }

  const result = out.join(SEP).split("|||").map(p => p.trim()).filter(Boolean);
  return result.length > 0 ? result : paragraphs;
}

// نسخة مكاشة من translateBatch: تتجنب إعادة ترجمة نفس الفصل لمستخدمين مختلفين
async function translateBatchCached(cacheKey, paragraphs) {
  const tKey = `translated:${cacheKey}`;
  const cached = cacheGet(tKey);
  if (cached) return cached;
  const translated = await translateBatch(paragraphs);
  cacheSet(tKey, translated);
  return translated;
}

async function fetchHTML(url) {
  const attempts = [
    { url, headers: BROWSER_HEADERS(), proxyRef: null },
    ...orderedProxies().map((p) => ({ url: p.build(url), headers: { "User-Agent": randomUA() }, proxyRef: p }))
  ];
  for (const a of attempts) {
    try {
      const res = await axios.get(a.url, { timeout: 20000, headers: a.headers, validateStatus: () => true });
      if (res.status >= 400) continue;
      const html = typeof res.data === "string" ? res.data : String(res.data);
      if (html.length < 500) continue;
      const lower = html.substring(0, 3000).toLowerCase();
      if (lower.includes("just a moment") || lower.includes("cloudflare")) continue;
      if (a.proxyRef) a.proxyRef.successCount += 1; // تسجيل نجاح هذا البروكسي لرفع أولويته لاحقًا
      return html;
    } catch (_) {}
  }
  throw new Error("فشلت جميع المحاولات");
}

function extractContent($, selectors) {
  let container = null;
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) { container = el; break; }
  }
  if (!container) return null;
  container.find("script,style,ins,.ads,.ad,noscript").remove();
  let paras = [];
  container.find("p").each((_, el) => {
    const t = cleanText($(el).text());
    if (t.length > 15 && !isFiltered(t)) paras.push(t);
  });
  if (paras.length < 3) {
    paras = container.text().split(/\n+/).map(p => cleanText(p)).filter(p => p.length > 15 && !isFiltered(p));
  }
  return paras.length > 0 ? paras : null;
}

// ─── WuxiaBox: بناء مباشر بالـ slug + تصحيح رقم الفصل إذا انحرف ──
// البنية: /novel/{slug}_{ch}.html
// لكن الـ index الداخلي قد يختلف عن رقم الفصل الحقيقي بفارق صغير
// نبني الرابط مباشرة ثم نتحقق من العنوان ونصحح ±15 إذا لزم
const wuxiaBoxIDCache = new Map();

async function resolveWuxiaBoxUrl(slug, chapterNum) {
  const cacheKey = `wuxia:${slug}:${chapterNum}`;
  if (wuxiaBoxIDCache.has(cacheKey)) return wuxiaBoxIDCache.get(cacheKey);

  // جرّب الرابط المباشر أولاً
  const candidates = [chapterNum];
  for (let i = 1; i <= 15; i++) {
    candidates.push(chapterNum + i);
    candidates.push(chapterNum - i);
  }

  for (const idx of candidates) {
    if (idx < 1) continue;
    const url = `https://www.wuxiabox.com/novel/${slug}_${idx}.html`;
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      // تحقق من رقم الفصل في العنوان أو الـ h2/h3
      const headText = [
        $("title").text(),
        $("h2").first().text(),
        $("h3").first().text(),
        $(".chapter-title").first().text(),
      ].join(" ");
      const match = headText.match(/chapter\s*(\d+)/i);
      if (match && parseInt(match[1]) === chapterNum) {
        console.log(`[WuxiaBox] ✅ فصل ${chapterNum} → index ${idx}`);
        wuxiaBoxIDCache.set(cacheKey, { url, html, $ });
        return { url, html, $ };
      }
      // إذا كان الـ index == chapterNum والعنوان لا يحتوي رقم فصل، اقبله كاحتمال
      if (idx === chapterNum && !match) {
        const content = extractContent($, ["article#chapter-article", "div.chapter-content", ".page-in"]);
        if (content && content.length > 3) {
          wuxiaBoxIDCache.set(cacheKey, { url, html, $ });
          return { url, html, $ };
        }
      }
    } catch (_) {}
  }
  return null;
}

async function fetchFromFallback(site, novelName, chapterNum) {
  const cacheKey = `${site.name}:${novelName}:${chapterNum}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const slug = site.slugify(novelName);
  if (!slug) throw new Error("اسم الرواية غير صالح بعد التحويل لرابط");

  let html, $, url;

  // WuxiaBox: بناء slug مباشر + تحقق من رقم الفصل وتصحيح ±15 إذا انحرف
  if (site.name === "WuxiaBox") {
    const wSlug = novelName.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const resolved = await resolveWuxiaBoxUrl(wSlug, chapterNum);
    if (!resolved) throw new Error(`WuxiaBox: لم يُعثر على الفصل ${chapterNum} في نطاق ±15`);
    ({ url, html, $ } = resolved);

  } else if (site.name === "NovelFull") {
    // NovelFull يضع عنوان الفصل في الرابط: /chapter-100-title-here.html
    // نجلب صفحة الفهرس ونبحث فيها عن رابط الفصل الصحيح
    const indexUrl = site.indexUrl(slug);
    const indexHtml = await fetchHTML(indexUrl);
    const $idx = cheerio.load(indexHtml);
    // الفهرس يعرض الفصول كـ <a href="/slug/chapter-100-...html">
    const chPattern = new RegExp(`/chapter-${chapterNum}[^"']*\\.html`, "i");
    let chapterUrl = null;
    $idx("a[href]").each((_, el) => {
      const href = $idx(el).attr("href") || "";
      if (chPattern.test(href)) {
        chapterUrl = href.startsWith("http") ? href : `https://novelfull.com${href}`;
        return false;
      }
    });
    // إذا لم يجد في الصفحة الأولى، جرّب صفحات الفهرس التالية (page=1, page=2 ...)
    if (!chapterUrl) {
      for (let page = 1; page <= 5 && !chapterUrl; page++) {
        try {
          const pageHtml = await fetchHTML(`${indexUrl}?page=${page}`);
          const $p = cheerio.load(pageHtml);
          $p("a[href]").each((_, el) => {
            const href = $p(el).attr("href") || "";
            if (chPattern.test(href)) {
              chapterUrl = href.startsWith("http") ? href : `https://novelfull.com${href}`;
              return false;
            }
          });
        } catch (_) {}
      }
    }
    if (!chapterUrl) throw new Error(`NovelFull: لم يُعثر على رابط الفصل ${chapterNum} في الفهرس`);
    url = chapterUrl;
    html = await fetchHTML(url);
    $ = cheerio.load(html);

  } else if (site.name === "NovelCrest") {
    // جرّب الرابط العادي أولاً، ثم مع لاحقة -2
    url = site.buildUrl(slug, site.buildChapter(chapterNum));
    try {
      html = await fetchHTML(url);
      $ = cheerio.load(html);
      if (!extractContent($, site.selectors) && site.buildUrlAlt) {
        throw new Error("محتوى فارغ، جرّب النسخة البديلة");
      }
    } catch (_) {
      if (site.buildUrlAlt) {
        url = site.buildUrlAlt(slug, site.buildChapter(chapterNum));
        html = await fetchHTML(url);
        $ = cheerio.load(html);
      } else throw _;
    }
  } else {
    url = site.buildUrl(slug, site.buildChapter(chapterNum));
    html = await fetchHTML(url);
    $ = cheerio.load(html);
  }

  const paragraphs = extractContent($, site.selectors);
  if (!paragraphs || paragraphs.length < 2) throw new Error(`محتوى فارغ (${paragraphs?.length || 0} فقرة)`);

  let title = "";
  for (const sel of site.titleSel) {
    try { const t = $(sel).first().text().trim().split(/[-|•]/)[0].trim(); if (t?.length > 2) { title = t; break; } } catch (_) {}
  }

  const result = { title: title || novelName, chapterTitle: `الفصل ${chapterNum}`, paragraphs, url, siteName: site.name };
  cacheSet(cacheKey, result);
  return result;
}

// ─── تقسيم النص لأجزاء ───────────────────────────────────────
function splitMessage(text, maxLen = 8000) {
  const chunks = [];
  let current = "";
  for (const para of text.split("\n\n")) {
    if ((current + para + "\n\n").length > maxLen) {
      if (current.trim()) chunks.push(current.trim());
      current = para + "\n\n";
    } else {
      current += para + "\n\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

// ─── محاولة الإرسال كرسالة واحدة فقط ──────────────────────────
// مسنجر قد يرفض الرسائل الطويلة جدًا (لا يوجد حد ثابت موثّق رسميًا
// لكنه عمليًا يرفض النصوص الكبيرة جدًا)، لذا نحاول أولًا، وإن فشلت
// المحاولة نرجع للتقسيم التقليدي بدل خسارة المحتوى بالكامل.
async function trySendAsSingleMessage(api, threadID, messageID, header, translated) {
  const fullText = header + translated.join("\n\n");
  try {
    await sendMessageAsync(api, fullText, threadID, messageID);
    return true;
  } catch (err) {
    console.warn(`[NOVEL] فشل إرسال الفصل كرسالة واحدة (${fullText.length} حرف): ${err.message?.substring(0, 150)}`);
    return false;
  }
}

// ─── إرسال كرسائل مقطعة ──────────────────────────────────────
async function sendAsChunks(api, threadID, messageID, header, translated, divider) {
  const fullText = header + translated.join("\n\n");
  const chunks = splitMessage(fullText);

  for (let i = 0; i < chunks.length; i++) {
    const suffix = chunks.length > 1 ? `\n\n${divider}\n📌 ${i + 1} / ${chunks.length}` : "";
    const body = chunks[i] + suffix;
    await new Promise(r => setTimeout(r, 800));
    await sendMessageAsync(api, body, threadID, messageID);
  }
}

// ─── إرسال كملف .txt ─────────────────────────────────────────
async function sendAsFile(api, threadID, messageID, novelName, chapterNum, header, translated) {
  const content = header + translated.join("\n\n");
  const safeNovel = novelName.replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "_") || "novel";
  const fileName = `${safeNovel}_Ch${chapterNum}.txt`;
  const tmpPath = path.join(os.tmpdir(), fileName);

  fs.writeFileSync(tmpPath, content, "utf8"); // إذا فشل هنا، لا يوجد ملف لحذفه أصلاً

  try {
    return await sendMessageAsync(
      api,
      { body: `📖 تم تجهيز الفصل ${chapterNum} كملف نصي لسهولة القراءة.`, attachment: fs.createReadStream(tmpPath) },
      threadID,
      messageID
    );
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

module.exports = {
  config: {
    name: "novel",
    aliases: ["رواية", "فصل", "read"],
    version: "9.1.0",
    author: "Sunken",
    countDown: 20,
    role: 0,
    shortDescription: { ar: "قراءة فصول الروايات مترجمة للعربية" },
    category: "tools",
    guide: { ar: "{pn}novel [اسم الرواية] [رقم الفصل]\nمثال: .novel martial peak 1" }
  },

  onStart: async function ({ api, event, args, message }) {
    const { threadID, messageID } = event;

    if (args.length < 2) {
      return api.sendMessage(
        "📚 قارئ الروايات\n\n" +
        "📝 الاستخدام:\n  .novel [اسم الرواية] [رقم الفصل]\n\n" +
        "💡 أمثلة:\n" +
        "  .novel martial peak 1\n" +
        "  .novel solo leveling 100\n" +
        "  .novel kingdom's bloodline 627\n\n" +
        "🌐 المصادر (5 مواقع بالتوازي):\n" +
        "  ① AllNovelFull ② NovelFull\n" +
        "  ③ NovelFire ④ INovelHub\n" +
        "  ⑤ NovelCrest\n" +
        "  🔁 WuxiaBox (احتياطي فقط)\n\n" +
        "🔄 الترجمة تلقائية للعربية\n" +
        "📨 يُرسل كرسائل مقطعة + ملف .txt",
        threadID, null, messageID
      );
    }

    const lastArg = args[args.length - 1];
    if (isNaN(lastArg) || Number(lastArg) < 1) {
      return api.sendMessage(
        "❌ يجب أن يكون آخر شيء في الأمر رقم الفصل\n💡 مثال: .novel martial peak 1",
        threadID, null, messageID
      );
    }
    const chapterNum = parseInt(lastArg);
    const novelName  = args.slice(0, -1).join(" ").trim();

    if (!novelName) {
      return api.sendMessage(
        "❌ يجب كتابة اسم الرواية قبل رقم الفصل\n💡 مثال: .novel martial peak 1",
        threadID, null, messageID
      );
    }

    let statusMsgId = null;
    try {
      const sent = await sendMessageAsync(
        api,
        `⏳ جاري جلب الفصل...\n📖 ${novelName}\n📄 الفصل ${chapterNum}\n\n⚠️ قد يستغرق حتى 30 ثانية`,
        threadID,
        messageID
      );
      statusMsgId = sent?.messageID;
    } catch (_) {}

    const updateStatus = async (text) => {
      try { if (statusMsgId) await api.editMessage(text, statusMsgId); } catch (_) {}
    };

    // ─── تجريب كل المواقع بالتوازي (أول نجاح يكسب) مع سقف زمني إجمالي ───
    await updateStatus(`🔍 جلب من ${FALLBACK_SITES.length} مصادر بالتوازي...\n📖 ${novelName}\n📄 الفصل ${chapterNum}`);

    const OVERALL_TIMEOUT = 30000; // 30 ثانية (WuxiaBox يحتاج طلبين، NovelFull يحتاج فهرس)
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("انتهى الوقت المسموح (timeout)")), OVERALL_TIMEOUT)
    );

    let result = null;
    let cacheKeyUsed = null;
    const siteErrors = {}; // تتبع أسباب فشل كل موقع
    try {
      const tasks = FALLBACK_SITES.map((site) => ({
        siteName: site.name,
        promise: fetchFromFallback(site, novelName, chapterNum).catch(err => {
          siteErrors[site.name] = err.message?.substring(0, 80);
          throw err;
        }),
      }));
      const winner = await Promise.race([raceFirstSuccess(tasks), timeoutPromise]);
      result = winner.value;
      cacheKeyUsed = `${winner.siteName}:${novelName}:${chapterNum}`;
      console.log(`[NOVEL] ✅ ${winner.siteName} نجح أولاً`);
    } catch (err) {
      console.warn(`[NOVEL] فشلت كل المصادر الأساسية أو انتهى الوقت: ${err.message?.substring(0, 200)}`);
    }

    // ─── WuxiaBox: يُجرَّب فقط إذا فشلت جميع المواقع الأساسية ───────
    // (جودة نصه/ترجمته أضعف من باقي المواقع، فهو خيار أخير لا أول خيار)
    if (!result) {
      await updateStatus(`🔁 المصادر الأساسية فشلت، تجربة مصدر احتياطي...\n📖 ${novelName}\n📄 الفصل ${chapterNum}`);
      try {
        const winner = await fetchFromFallback(WUXIABOX_SITE, novelName, chapterNum);
        result = winner;
        cacheKeyUsed = `${WUXIABOX_SITE.name}:${novelName}:${chapterNum}`;
        console.log(`[NOVEL] ✅ ${WUXIABOX_SITE.name} نجح كاحتياطي أخير`);
      } catch (err) {
        siteErrors[WUXIABOX_SITE.name] = err.message?.substring(0, 80);
        console.warn(`[NOVEL] فشل الاحتياطي WuxiaBox أيضًا: ${err.message?.substring(0, 200)}`);
      }
    }

    if (!result) {
      const errorDetails = Object.entries(siteErrors)
        .map(([site, err]) => `• ${site}: ${err}`)
        .join("\n");
      const errMsg =
        `❌ لم أجد الفصل في أي مصدر\n\n` +
        `📖 ${novelName} | 📄 الفصل ${chapterNum}\n\n` +
        (errorDetails ? `🔍 تفاصيل الأخطاء:\n${errorDetails}\n\n` : "") +
        `💡 تأكد من:\n• الاسم الإنجليزي الصحيح\n• رقم الفصل صحيح`;
      try {
        if (statusMsgId) await api.editMessage(errMsg, statusMsgId);
        else api.sendMessage(errMsg, threadID, null, messageID);
      } catch (_) { api.sendMessage(errMsg, threadID, null, messageID); }
      return;
    }

    await updateStatus(`🔄 ترجمة ${result.paragraphs.length} فقرة...\n📖 ${result.title}\n🌐 ${result.siteName}`);
    const translated = await translateBatchCached(cacheKeyUsed, result.paragraphs);

    const divider = "─".repeat(35);
    const chapterLabel = result.chapterTitle || `الفصل ${chapterNum}`;
    const header = `📖 ${result.title}\n📄 ${chapterLabel}\n🌐 ${result.siteName}\n${divider}\n\n`;

    // حذف رسالة الحالة
    try { if (statusMsgId) await api.unsendMessage(statusMsgId, threadID); } catch (_) {}

    // ① تجربة الإرسال كرسالة واحدة أولاً (قد يرفضها مسنجر لطولها)
    const sentAsSingle = await trySendAsSingleMessage(api, threadID, messageID, header, translated);

    // إذا فشلت الرسالة الواحدة، نرجع للتقسيم التقليدي كحل احتياطي
    if (!sentAsSingle) {
      try {
        await sendAsChunks(api, threadID, messageID, header, translated, divider);
      } catch (err) {
        console.error("[NOVEL] فشل إرسال الرسائل المقطعة:", err.message);
      }
    }

    // ② ثم إرسال كملف .txt
    try {
      await sendAsFile(api, threadID, messageID, novelName, chapterNum, header, translated);
    } catch (err) {
      console.error("[NOVEL] فشل إرسال الملف:", err.message);
      api.sendMessage(`❌ فشل إرسال الملف: ${err.message}`, threadID, null, messageID);
    }
  }
};
