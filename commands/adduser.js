const axios = require('axios');

// ⚠️ لا تترك مفتاحاً حقيقياً كقيمة افتراضية في الكود — يجب ضبط
// FB_GRAPH_ACCESS_TOKEN في متغيرات البيئة. بدونه تُتخطى طريقة Graph API
// تلقائياً وتُستخدم باقي طرق resolveUID.
const FB_GRAPH_TOKEN = process.env.FB_GRAPH_ACCESS_TOKEN || "";

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept-Language": "ar,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-fetch-site": "none",
  "sec-fetch-mode": "navigate",
};

module.exports = {
  config: {
    name: "adduser",
    aliases: ["اضافة", "ادع", "invite"],
    version: "4.1.0",
    author: "Enhanced UID Extractor",
    // ⏳ رُفع من 5 إلى 45 ثانية بين كل استخدامين — إضافة الأعضاء من أكثر
    // الأسباب شيوعاً لحظر/تقييد حسابات فيسبوك إن تكررت بسرعة
    countDown: 45,
    role: 1,
    shortDescription: { ar: "إضافة عضو عبر UID أو رابط فيسبوك" },
    category: "أدوات",
    guide: { ar: "{pn}adduser [UID أو رابط أو يوزرنيم]" }
  },

  // ── حد يومي صارم لكل مشرف (in-memory، يُصفّر كل 24 ساعة) ──
  // ملاحظة: هذا تخزين في الذاكرة فقط ويُصفّر عند إعادة تشغيل البوت.
  // إن أردت استمرارية الحد عبر عمليات إعادة التشغيل، اربطه بقاعدة
  // البيانات (UserModel) بدل هذا الـ Map.
  _dailyAddLog: new Map(), // senderID -> [timestamps]
  _DAILY_LIMIT: 8,
  _DAY_MS: 24 * 60 * 60 * 1000,

  onStart: async function ({ api, event, args, message }) {
    const { threadID, messageID, senderID } = event;

    // ── فحص الحد اليومي قبل أي معالجة ───────────────────────
    const now = Date.now();
    const log = (this._dailyAddLog.get(senderID) || []).filter(t => now - t < this._DAY_MS);
    if (log.length >= this._DAILY_LIMIT) {
      const waitMin = Math.ceil((this._DAY_MS - (now - log[0])) / 60000);
      return api.sendMessage(
        `⚠️ وصلت للحد الأقصى (${this._DAILY_LIMIT} إضافات/يوم) لحماية الحساب من الحظر.\n⏳ حاول بعد ${waitMin} دقيقة تقريباً.`,
        threadID, null, messageID
      );
    }

    // ── فحص صلاحية ───────────────────────────────────────────
    let threadInfo;
    try {
      threadInfo = await api.getThreadInfo(threadID);
    } catch (e) {
      return api.sendMessage("❌ فشل في جلب معلومات المجموعة.", threadID, null, messageID);
    }
    if (!threadInfo.adminIDs.some(admin => admin.id === senderID)) {
      return api.sendMessage("❌ هذا الأمر لمشرفي المجموعة فقط!", threadID, null, messageID);
    }

    const input = args.join(" ").trim();
    if (!input) {
      return api.sendMessage("❌ الاستخدام:\n.adduser [UID] أو [رابط فيسبوك] أو [يوزرنيم]", threadID, null, messageID);
    }

    const waitMsg = await api.sendMessage("🔄 جاري المعالجة...", threadID, null, messageID);
    const editMsg = async (text) => {
      try { await api.editMessage(text, waitMsg.messageID, threadID); } catch (_) {}
    };

    try {
      let uid = null;
      let userName = "المستخدم";

      // ── 1. رقم UID مباشر ─────────────────────────────────
      if (/^\d{5,20}$/.test(input)) {
        uid = input;

      // ── 2. رابط فيسبوك ────────────────────────────────────
      } else if (/facebook\.com|fb\.com|fb\.me/i.test(input)) {
        await editMsg("🔍 جاري استخراج UID من الرابط...");
        uid = await resolveUID(input);

      // ── 3. يوزرنيم نصي ───────────────────────────────────
      } else if (/^[a-zA-Z0-9._]+$/.test(input)) {
        await editMsg("🔍 جاري البحث عن المستخدم...");
        uid = await resolveUID(`https://www.facebook.com/${input}`);
      }

      if (!uid) {
        return await editMsg(
          "❌ فشل استخراج UID.\n" +
          "💡 الحل: استخدم UID الرقمي مباشرة.\n" +
          "🔗 للحصول على UID: .uid [الرابط]"
        );
      }

      if (threadInfo.participantIDs.includes(uid)) {
        return await editMsg("⚠️ المستخدم موجود بالفعل في المجموعة.");
      }

      try {
        const info = await api.getUserInfo(uid);
        if (info?.[uid]) userName = info[uid].name || userName;
      } catch (_) {}

      await editMsg(`🔄 جاري إضافة ${userName}...`);

      try {
        await new Promise((resolve, reject) => {
          api.addUserToGroup(uid, threadID, (err) => err ? reject(err) : resolve());
        });
      } catch (addError) {
        let errorMsg = `❌ فشل في إضافة ${userName}\n`;
        if (addError.error === "Not enough members to add") errorMsg += "المجموعة تحتاج موافقة الأدمن.";
        else if (addError.error === "Privacy") errorMsg += "المستخدم لديه إعدادات خصوصية تمنع إضافته.";
        else errorMsg += addError.message || "سبب غير معروف";
        return await editMsg(errorMsg);
      }

      await editMsg(`✅ تمت الإضافة بنجاح!\n👤 الاسم: ${userName}\n🆔 UID: ${uid}`);

      // تسجيل العملية الناجحة ضمن الحد اليومي لهذا المشرف
      log.push(now);
      this._dailyAddLog.set(senderID, log);
      const remaining = Math.max(0, this._DAILY_LIMIT - log.length);
      if (remaining <= 2) {
        await api.sendMessage(`ℹ️ تبقى لك ${remaining} عملية إضافة اليوم.`, threadID, null, messageID);
      }

    } catch (error) {
      console.error("[AddUser Fatal]", error);
      await editMsg("❌ حدث خطأ غير متوقع.");
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// resolveUID — يجرّب طرقاً متعددة بالترتيب حتى ينجح إحداها
// ═══════════════════════════════════════════════════════════════
async function resolveUID(input) {
  input = input.trim();

  // ── طريقة 0: UID رقمي في الرابط ─────────────────────────
  const numInUrl = input.match(/(?:facebook\.com\/(?:profile\.php\?id=)?|\/)?(\d{8,20})/);
  if (numInUrl) return numInUrl[1];

  // ── تنظيف الرابط واستخراج الـ slug ──────────────────────
  let slug = input;
  try {
    slug = new URL(input.startsWith("http") ? input : "https://" + input).pathname
      .replace(/^\//, "").replace(/\/$/, "").split("/")[0];
  } catch (_) {
    slug = input.replace(/^.*facebook\.com\//i, "").split(/[/?#]/)[0];
  }

  // تجاهل المسارات غير الشخصية
  const ignoreSlugs = ["watch", "reel", "reels", "stories", "groups", "marketplace",
    "pages", "events", "photo", "video", "share", "sharer", "permalink"];
  if (!slug || ignoreSlugs.includes(slug.toLowerCase())) return null;

  // ── طريقة 1: Graph API (قد يعمل مع بعض الـ usernames) ──
  if (FB_GRAPH_TOKEN) {
    try {
      const res = await axios.get(`https://graph.facebook.com/${encodeURIComponent(slug)}`, {
        params: { fields: "id", access_token: FB_GRAPH_TOKEN },
        timeout: 8000,
      });
      if (res.data?.id) return res.data.id;
    } catch (_) {}
  }

  // ── طريقة 2: scrape صفحة فيسبوك مباشرة ─────────────────
  const profileUrl = `https://www.facebook.com/${slug}`;
  try {
    const html = await fetchHTML(profileUrl);
    const id   = extractIDFromHTML(html);
    if (id) return id;
  } catch (_) {}

  // ── طريقة 3: النسخة المحمولة mbasic ─────────────────────
  try {
    const html = await fetchHTML(`https://mbasic.facebook.com/${slug}`);
    const id   = extractIDFromHTML(html);
    if (id) return id;
  } catch (_) {}

  // ── طريقة 4: API بديل (lookup2) ─────────────────────────
  try {
    const res = await axios.get(`https://lookup2.p.rapidapi.com/`, {
      params: { username: slug },
      headers: {
        "x-rapidapi-host": "lookup2.p.rapidapi.com",
        "x-rapidapi-key": process.env.RAPIDAPI_KEY || "",
      },
      timeout: 8000,
    });
    if (res.data?.id) return res.data.id;
  } catch (_) {}

  // ── طريقة 5: findmyfbid.com ──────────────────────────────
  try {
    const html = await fetchHTML(`https://findmyfbid.com/`, {
      method: "POST",
      data: new URLSearchParams({ url: profileUrl }).toString(),
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://findmyfbid.com/",
      },
    });
    const match = html.match(/(?:id|uid|facebook id)[^\d]*(\d{8,20})/i);
    if (match) return match[1];
  } catch (_) {}

  return null;
}

// ── تحميل HTML ───────────────────────────────────────────────
async function fetchHTML(url, options = {}) {
  const res = await axios({
    url,
    method:  options.method || "GET",
    data:    options.data,
    headers: { ...BROWSER_HEADERS, ...(options.headers || {}) },
    timeout: 15000,
    maxRedirects: 5,
  });
  return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
}

// ── استخراج ID من HTML فيسبوك ────────────────────────────────
function extractIDFromHTML(html) {
  if (!html) return null;

  const patterns = [
    /"userID"\s*:\s*"(\d+)"/,
    /"entity_id"\s*:\s*"(\d+)"/,
    /"profileOwnerID"\s*:\s*"(\d+)"/,
    /"USER_ID"\s*:\s*"(\d+)"/,
    /"owner"\s*:\s*\{"__typename"[^}]*"id"\s*:\s*"(\d+)"/,
    /content="https:\/\/www\.facebook\.com\/(\d{8,20})"/,
    /"id"\s*:\s*"(\d{8,20})"\s*,\s*"name"/,
    /profile_id=(\d{8,20})/,
    /\"subject_id\"\s*:\s*\"(\d{8,20})\"/,
    /pageID\s*=\s*"(\d{8,20})"/,
    /__user=(\d{8,20})/,
    /\{"uid":(\d{8,20})\}/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1] && match[1] !== "0") return match[1];
  }
  return null;
}
