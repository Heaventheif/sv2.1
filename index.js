/* jshint esversion: 11 */
"use strict";

// ════════════════════════════════════════════════════════════
//  ⚙️  بيانات تسجيل الدخول الاحتياطي
//  ضعها هنا أو في متغيرات البيئة (Environment Variables)
//  على Render: Settings → Environment Variables
// ════════════════════════════════════════════════════════════
const FB_EMAIL    = process.env.FB_EMAIL    || "EMAIL_HERE";
const FB_PASSWORD = process.env.FB_PASSWORD || "PASSWORD_HERE";

// مفتاح المصادقة الثنائية (2FA Secret Key) من إعدادات حسابك
// إذا لم يكن لديك 2FA مفعّل، اتركه فارغاً: ""
const FB_2FA_SECRET = process.env.FB_2FA_SECRET || "2FA_SECRET_HERE";

// ════════════════════════════════════════════════════════════

// ─── منع EPIPE وأخطاء الشبكة من إسقاط البوت ─────────────────
process.on("uncaughtException", (err) => {
  if (err.code === "EPIPE" || err.code === "ECONNRESET" || err.code === "ETIMEDOUT") return;
  console.error("[uncaughtException]", err.message);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes("EPIPE") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT")) return;
  console.error("[unhandledRejection]", msg);
});

// ─── Globals ─────────────────────────────────────────────────
global.client           = { reactionListener: {} };
global.Kagenou          = { replies: {} };
global.config           = { admins: [], moderators: [], developers: [], vips: [], Prefix: ["."], botName: "Sunken Bot" };
global.globalData       = new Map();
global.usersData        = new Map();
global.userCooldowns    = new Map();
global.commands         = new Map();
global.nonPrefixCommands= new Map();
global.eventCommands    = [];
global.appState         = {};
global.botApi           = null;

// ─── Send Queue (تسلسلي + تأخير لحماية الحساب) ──────────────
// المعالجة تبقى بالتوازي — فقط لحظة الإرسال الفعلي تمر عبر هذا الـ queue
(() => {
  const SEND_DELAY_MS = 1000; // تأخير ثانية واحدة بين كل رسالة
  let _queue   = [];
  let _running = false;

  async function _runQueue() {
    if (_running) return;
    _running = true;
    while (_queue.length > 0) {
      const { api, body, threadID, callback, messageID } = _queue.shift();
      try {
        await new Promise((resolve) => {
          if (messageID !== undefined) {
            api.sendMessage(body, threadID, (err, info) => {
              if (callback) callback(err, info);
              resolve();
            }, messageID);
          } else {
            api.sendMessage(body, threadID, (err, info) => {
              if (callback) callback(err, info);
              resolve();
            });
          }
        });
      } catch (e) {
        console.error("[SEND_QUEUE] خطأ أثناء الإرسال:", e.message);
      }
      // تأخير بين الرسائل لحماية الحساب
      if (_queue.length > 0) {
        await new Promise(r => setTimeout(r, SEND_DELAY_MS));
      }
    }
    _running = false;
  }

  /**
   * global.safeSend(api, body, threadID, callback?, messageID?)
   * نفس توقيع api.sendMessage تماماً — تُضاف للـ queue وتُرسَل بالتسلسل
   * بينما المعالجة (fetchHTML, translateBatch, إلخ) تبقى بالتوازي كما هي
   */
  global.safeSend = (api, body, threadID, callback, messageID) => {
    _queue.push({ api, body, threadID, callback, messageID });
    _runQueue();
  };
})();

const fs       = require("fs-extra");
const path     = require("path");
const login    = require("@dongdev/fca-unofficial");
const chalk    = require("chalk");
const express  = require("express");

try { require("dotenv").config(); } catch (_) {}

// ─── Logger ──────────────────────────────────────────────────
global.log = {
  info:    msg => console.log(chalk.blue("[INFO]"),    msg),
  warn:    msg => console.log(chalk.yellow("[WARN]"),  msg),
  error:   msg => console.log(chalk.red("[ERROR]"),    msg),
  success: msg => console.log(chalk.green("[SUCCESS]"), msg),
};


// ─── Role Sets (تُبنى مرة واحدة، تُحدَّث عند reload) ──────────
function buildRoleSets() {
  global._rolesets = {
    dev:  new Set((global.config.developers || []).map(String)),
    vip:  new Set((global.config.vips       || []).map(String)),
    mod:  new Set((global.config.moderators || []).map(String)),
    adm:  new Set((global.config.admins     || []).map(String)),
  };
}
buildRoleSets();

global.getUserRole = uid => {
  uid = String(uid);
  const r = global._rolesets;
  if (r.dev.has(uid)) return 4;
  if (r.vip.has(uid)) return 3;
  if (r.mod.has(uid)) return 2;
  if (r.adm.has(uid)) return 1;
  return 0;
};

// ─── Cooldown (يحذف المنتهي فوراً) ────────────────────────────
global.setCooldown   = (u, c, t) => global.userCooldowns.set(`${u}:${c}`, Date.now() + t * 1000);
global.checkCooldown = (u, c) => {
  const key = `${u}:${c}`;
  const exp = global.userCooldowns.get(key);
  if (!exp || Date.now() >= exp) {
    global.userCooldowns.delete(key); // ← حذف فوري عند الانتهاء
    return null;
  }
  return `⏳ انتظر ${Math.ceil((exp - Date.now()) / 1000)} ث`;
};

// ─── تحميل Config ────────────────────────────────────────────
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  global.config = { ...global.config, ...cfg, Prefix: cfg.Prefix || ["."] };
  buildRoleSets(); // أعد بناء الـ Sets بعد تحميل config
} catch { console.warn("[WARN] Using default config"); }

// ─── تحميل الأوامر ───────────────────────────────────────────
const loadCommands = () => {
  const dir = path.join(__dirname, "commands");
  if (!fs.existsSync(dir)) return;
  global.commands.clear();
  global.nonPrefixCommands.clear();
  global.eventCommands = [];

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
  for (const file of files) {
    try {
      const p   = path.join(dir, file);
      delete require.cache[require.resolve(p)];
      const cmd = require(p);
      const mod = cmd.default || cmd;
      if (mod.config?.name && (mod.onStart || mod.run || mod.execute)) {
        const name = mod.config.name.toLowerCase();
        global.commands.set(name, mod);
        global.nonPrefixCommands.set(name, mod);
        (mod.config.aliases || []).forEach(a => {
          global.commands.set(a.toLowerCase(), mod);
          global.nonPrefixCommands.set(a.toLowerCase(), mod);
        });
      }
      if (mod.onChat || mod.handleEvent) global.eventCommands.push(mod);
    } catch (err) { console.warn(`[WARN] فشل تحميل '${file}': ${err.message}`); }
  }
  console.log(chalk.blue(`[INFO] تم تحميل ${global.commands.size} أمر`));
};
global.reloadCommands = loadCommands;

// ─── AppState ────────────────────────────────────────────────
try {
  const p = path.join(__dirname, "appstate.json");
  if (fs.existsSync(p)) {
    global.appState = JSON.parse(fs.readFileSync(p, "utf8"));
  } else if (process.env.APPSTATE || process.env.APPSTATE_BOT1) {
    global.appState = JSON.parse(process.env.APPSTATE || process.env.APPSTATE_BOT1);
  }
} catch { }

// ─── Message Handler ─────────────────────────────────────────
const handleMessage = async (api, event) => {
  const { threadID, senderID, body, messageReply, messageID } = event;
  const hasAttachment = (event.attachments?.length > 0);
  if (!body?.trim() && !hasAttachment) return;

  const messageText = body.trim();

  // ─── Reply handler ────────────────────────────────────────
  if (messageReply && global.Kagenou.replies?.[messageReply.messageID]) {
    const replyData = global.Kagenou.replies[messageReply.messageID];
    // لا نحذف الرد حتى نتأكد من التنفيذ
    if (!replyData.author || replyData.author === senderID) {
      delete global.Kagenou.replies[messageReply.messageID];
      // يدعم كلاً من: onReply (yt.js) و callback (أوامر أخرى)
      // إذا لم يكن هناك handler محفوظ، ابحث عن onReply في الأمر نفسه
      const cmdForReply = replyData.commandName
        ? global.commands.get(replyData.commandName)
        : null;
      const handler = replyData.onReply || replyData.callback ||
        (cmdForReply?.onReply ? (...a) => cmdForReply.onReply(...a) : null);
      if (typeof handler === "function") {
        const replyMessage = {
          reply: (t, cb) => {
            return new Promise((resolve) => {
              global.safeSend(api, t, threadID, (err, info) => {
                if (cb) cb(err, info);
                resolve(info || {});
              });
            });
          },
          unsend: (msgID) => {
            try { api.unsendMessage(msgID, () => {}); } catch (_) {}
          },
          registerReply: (id, d, cb) => {
            global.Kagenou.replies[id] = { callback: cb, author: senderID, timestamp: Date.now(), ...d };
          }
        };
        // بالخلفية — لا يحجب معالجة الأحداث التالية
        handler({ api, event, message: replyMessage, Reply: replyData })
          .catch(e => console.error("[REPLY ERROR]", e.message));
      }
    }
    return;
  }

  // ─── Command routing ──────────────────────────────────────
  const parts       = messageText.split(/ +/);
  const commandName = parts[0]?.toLowerCase();
  const args        = parts.slice(1);
  const command     = global.commands.get(commandName);
  if (!command) return;

  // ─── Role check ───────────────────────────────────────────
  const role    = global.getUserRole(senderID);
  const reqRole = command.config?.role ?? 0;
  if (role < reqRole) {
    global.safeSend(api, "⚠️ هذا الأمر للمشرفين فقط", threadID, null, messageID);
    return;
  }

  // ─── Cooldown ─────────────────────────────────────────────
  const cd    = command.config?.countDown ?? 3;
  const cdMsg = global.checkCooldown(senderID, commandName);
  if (cdMsg) { global.safeSend(api, cdMsg, threadID, null, messageID); return; }
  global.setCooldown(senderID, commandName, cd);

  // ─── Execute (بالخلفية — لا await هنا لحماية التوازي) ────
  // ⏳ تفاعل فوري يُعلم المستخدم أن البوت استلم الطلب
  try { api.setMessageReaction("⏳", messageID, threadID, () => {}, true); } catch (_) {}

  // الـ promise تعمل بالخلفية — handleMessage يعود فوراً لاستقبال الطلب التالي
  (async () => {
    try {
      const ctx = {
        api, event, args,
        message: {
          // كل ردود الأوامر تمر عبر safeSend (queue مشترك + تأخير)
          reply: (t, cb) => {
            return new Promise((resolve) => {
              global.safeSend(api, t, threadID, (err, info) => {
                if (cb) cb(err, info);
                resolve(info || {});
              }, messageID);
            });
          },
          unsend: (msgID) => {
            try { api.unsendMessage(msgID, () => {}); } catch (_) {}
          },
          registerReply: (id, d, cb) => {
            global.Kagenou.replies[id] = { callback: cb, author: senderID, timestamp: Date.now(), ...d };
          }
        },
        prefix: "", usersData: global.usersData,
        globalData: global.globalData, db: global.db,
      };
      if      (command.onStart) await command.onStart(ctx);
      else if (command.run)     await command.run(ctx);
      else if (command.execute) await command.execute(api, event, args, global.commands, "", global.config.admins, global.appState, t => global.safeSend(api, t, threadID, null, messageID), global.usersData, global.globalData);
      // ✅ تفاعل نجاح بعد انتهاء الأمر
      try { api.setMessageReaction("✅", messageID, threadID, () => {}, true); } catch (_) {}
    } catch (err) {
      console.error(`[CMD ERR] ${commandName}:`, err.message);
      // ❌ تفاعل فشل
      try { api.setMessageReaction("❌", messageID, threadID, () => {}, true); } catch (_) {}
      global.safeSend(api, `❌ خطأ: ${err.message?.substring(0, 100)}`, threadID, null, messageID);
    }
  })();
};

// ─── Reaction Handler ──────────────────────────────────────────
const handleReaction = (api, event) => {
  const msgID = event.messageID;
  if (!msgID) return;

  const entry = global.client.reactionListener[msgID];
  if (!entry) return;

  if (entry.author && event.userID !== entry.author) return;

  // بالخلفية
  Promise.resolve(entry.callback({ api, event }))
    .catch(e => console.error("[REACTION ERR]", e.message));
};

// ─── Event Handler ────────────────────────────────────────────
const handleEvent = async (api, event) => {
  // ━━━ إصلاح السبب الأول للتنفيذ المزدوج ━━━━━━━━━━━━━━━━━━━━
  // إذا كانت الرسالة تبدأ بكلمة تُطابق أمراً معروفاً في global.commands،
  // فسيُعالجه handleMessage عبر onStart — نتجنب استدعاء onChat لنفس الأمر
  const firstWord = event.body?.trim().split(/ +/)[0]?.toLowerCase();

  for (const cmd of global.eventCommands) {
    if (!cmd.onChat) continue;
    const hasAtt = (event.attachments?.length > 0);
    if (!event.messageID || (!event.body && !hasAtt)) continue;
    if (firstWord && global.commands.get(firstWord) === cmd) continue;

    // كل onChat تعمل بالخلفية — لا تنتظر السابقة
    cmd.onChat({
      api, event,
      message: {
        reply: (t, cb) => new Promise(res =>
          global.safeSend(api, t, event.threadID, (e, i) => { if (cb) cb(e, i); res(i || {}); }, event.messageID)
        ),
        unsend: (msgID) => { try { api.unsendMessage(msgID, () => {}); } catch (_) {} }
      }
    }).catch(() => {});
  }
};

// ─── MQTT Listener ────────────────────────────────────────────
const startListening = (api) => {
  let attempts       = 0;
  let listenerActive = false; // ← إصلاح السبب الثاني: يمنع تراكم المستمعين

  const listen = () => {
    // ← إذا كان هناك مستمع نشط بالفعل، لا ننشئ آخر
    if (listenerActive) return;
    listenerActive = true;

    api.listenMqtt(async (err, event) => {
      if (err) {
        listenerActive = false; // ← نُعلن أن المستمع انتهى قبل إنشاء واحد جديد
        attempts++;
        console.error(chalk.red(`[MQTT] خطأ (${attempts}):`, err.message));
        return setTimeout(listen, Math.min(5000 * attempts, 30000));
      }
      attempts = 0;
      try {
        if (["message","message_reply","log","event"].includes(event.type)) {
          await handleEvent(api, event);
          await handleMessage(api, event);
        } else if (event.type === "message_reaction") {
          await handleReaction(api, event);
        }
      } catch (e) { console.error("[EVENT ERR]", e.message); }
    });
  };
  listen();
  console.log(chalk.green("[SUCCESS] Bot listening..."));
};

// ─── Web Server (Render keep-alive) ──────────────────────────
// يجب أن يبدأ أولاً — Render ينتظر منفذاً مفتوحاً خلال 3-4 دقائق
function startWebServer() {
  const PORT = parseInt(process.env.PORT || "10000");
  const app  = express();

  // الصفحة الرئيسية — تُظهر حالة البوت
  app.get("/", (_req, res) => {
    res.send(`
      <!DOCTYPE html><html lang="ar" dir="rtl">
      <head><meta charset="UTF-8"><title>${global.config.botName}</title></head>
      <body style="font-family:sans-serif;padding:30px;background:#0d1117;color:#c9d1d9">
        <h2>🤖 ${global.config.botName}</h2>
        <p>الحالة: <b style="color:#3fb950">✅ يعمل</b></p>
        <p>⏱️ Uptime: ${Math.floor(process.uptime())} ثانية</p>
        <p>📦 الأوامر: ${global.commands.size}</p>
        <p>🔗 البوت: ${global.botApi ? "متصل" : "جاري الاتصال..."}</p>
      </body></html>
    `);
  });

  // health check — هذا ما يستخدمه Render (healthCheckPath: /api/health)
  app.get("/health",     healthHandler);
  app.get("/api/health", healthHandler);

  function healthHandler(_req, res) {
    res.json({
      status:    "ok",
      bot:       global.botApi ? "connected" : "connecting",
      commands:  global.commands.size,
      uptime:    Math.floor(process.uptime()),
      memory:    `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
      timestamp: new Date().toISOString(),
    });
  }

  // ════════════════════════════════════════════════════════
  //  🎵 YouTube Routes — @vreden/youtube_scraper
  // ════════════════════════════════════════════════════════
  (() => {
    const { search, ytmp3, ytmp4 } = require("@vreden/youtube_scraper");
    const os   = require("os");
    const axios = require("axios");

    app.use(express.json());

    function fmtDur(sec) {
      if (!sec) return "--";
      const m = Math.floor(sec / 60), s = sec % 60, h = Math.floor(m / 60);
      return h ? `${h}:${String(m%60).padStart(2,"0")}:${String(s).padStart(2,"0")}`
               : `${m}:${String(s).padStart(2,"0")}`;
    }

    async function downloadFile(url, destPath) {
      const response = await axios.get(url, {
        responseType: "stream",
        timeout: 5 * 60 * 1000,
        maxContentLength: 200 * 1024 * 1024,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      });
      const writer = fs.createWriteStream(destPath);
      response.data.pipe(writer);
      return new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
    }

    // POST /yt/search
    app.post("/yt/search", async (req, res) => {
      try {
        const query = (req.body?.query || "").trim();
        const limit = Math.min(parseInt(req.body?.limit || 10), 15);
        if (!query) return res.status(400).json({ error: "query مطلوب" });

        const data = await search(query);
        if (!data.status || !data.results?.length)
          return res.status(404).json({ error: data.message || "لا توجد نتائج" });

        const results = data.results.slice(0, limit).map(v => ({
          id:       v.videoId || "",
          title:    v.title   || "بدون عنوان",
          url:      v.url     || `https://www.youtube.com/watch?v=${v.videoId}`,
          duration: v.timestamp || fmtDur(v.seconds) || "--",
          uploader: v.author?.name || v.channel || "",
          thumb:    v.thumbnail || v.image || "",
        }));
        res.json({ results });
      } catch (e) {
        console.error("[YT/search]", e.message);
        res.status(500).json({ error: e.message?.slice(0, 300) });
      }
    });

    // POST /yt/audio → MP3
    app.post("/yt/audio", async (req, res) => {
      const url = (req.body?.url || "").trim();
      if (!url) return res.status(400).json({ error: "url مطلوب" });
      let tmpPath = null;
      try {
        const data = await ytmp3(url, 128);
        if (!data.status || !data.download?.url)
          return res.status(503).json({ error: data.message || "فشل استخراج رابط الصوت" });

        const meta     = data.metadata || {};
        const title    = meta.title || "audio";
        const duration = meta.seconds || 0;
        const uploader = meta.author?.name || meta.channel || "";

        tmpPath = path.join(os.tmpdir(), `yt_a_${Date.now()}.mp3`);
        await downloadFile(data.download.url, tmpPath);
        if (!(await fs.stat(tmpPath)).size) throw new Error("الملف المُنزَّل فارغ");

        res.set({
          "Content-Type":        "audio/mpeg",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(title)}.mp3"`,
          "X-Title":             encodeURIComponent(title),
          "X-Duration":          String(duration),
          "X-Uploader":          encodeURIComponent(uploader),
        });
        const stream = fs.createReadStream(tmpPath);
        stream.on("end",   () => fs.remove(tmpPath).catch(() => {}));
        stream.on("error", () => fs.remove(tmpPath).catch(() => {}));
        stream.pipe(res);
      } catch (e) {
        if (tmpPath) fs.remove(tmpPath).catch(() => {});
        console.error("[YT/audio]", e.message);
        res.status(500).json({ error: e.message?.slice(0, 300) });
      }
    });

    // POST /yt/video → MP4
    app.post("/yt/video", async (req, res) => {
      const url = (req.body?.url || "").trim();
      if (!url) return res.status(400).json({ error: "url مطلوب" });
      let tmpPath = null;
      try {
        const data = await ytmp4(url, 360);
        if (!data.status || !data.download?.url)
          return res.status(503).json({ error: data.message || "فشل استخراج رابط الفيديو" });

        const meta     = data.metadata || {};
        const title    = meta.title || "video";
        const duration = meta.seconds || 0;
        const uploader = meta.author?.name || meta.channel || "";

        tmpPath = path.join(os.tmpdir(), `yt_v_${Date.now()}.mp4`);
        await downloadFile(data.download.url, tmpPath);
        if (!(await fs.stat(tmpPath)).size) throw new Error("الملف المُنزَّل فارغ");

        res.set({
          "Content-Type":        "video/mp4",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(title)}.mp4"`,
          "X-Title":             encodeURIComponent(title),
          "X-Duration":          String(duration),
          "X-Uploader":          encodeURIComponent(uploader),
        });
        const stream = fs.createReadStream(tmpPath);
        stream.on("end",   () => fs.remove(tmpPath).catch(() => {}));
        stream.on("error", () => fs.remove(tmpPath).catch(() => {}));
        stream.pipe(res);
      } catch (e) {
        if (tmpPath) fs.remove(tmpPath).catch(() => {});
        console.error("[YT/video]", e.message);
        res.status(500).json({ error: e.message?.slice(0, 300) });
      }
    });

    console.log(chalk.green("[SUCCESS] 🎵 YouTube routes جاهزة (/yt/search, /yt/audio, /yt/video)"));
  })();

  app.listen(PORT, () => {
    console.log(chalk.green(`[SUCCESS] 🌐 Web server على المنفذ ${PORT}`));
  });

  global.expressApp = app;

  // ─── Keep-Alive: بنغ ذاتي كل 10 دقائق لمنع Render من النوم ────
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (externalUrl) {
    setInterval(() => {
      const url = externalUrl.replace(/\/$/, "") + "/health";
      const mod = url.startsWith("https") ? require("https") : require("http");
      const req = mod.get(url, (r) => {
        r.resume(); // تفريغ البيانات لإغلاق الاتصال بنجاح
        if (r.statusCode !== 200) console.warn("[KEEP-ALIVE] ⚠️ status:", r.statusCode);
      });
      req.on("error", (e) => console.warn("[KEEP-ALIVE] ⚠️ خطأ:", e.message));
      req.setTimeout(20000, () => req.destroy());
    }, 10 * 60 * 1000);
    console.log(chalk.cyan(`[KEEP-ALIVE] ✅ بنغ ذاتي مفعّل لـ ${externalUrl}`));
  } else {
    console.warn(chalk.yellow("[KEEP-ALIVE] ⚠️ RENDER_EXTERNAL_URL غير مضبوط — البوت قد ينام بعد 15 دقيقة خمول (Free Plan)"));
  }
}

// ─── DB ──────────────────────────────────────────────────────
const { connectDB } = require("./db/index");

// ════════════════════════════════════════════════════════════
//  🔐 توليد رمز 2FA تلقائياً (TOTP)
// ════════════════════════════════════════════════════════════
function generate2FACode(secret) {
  if (!secret || secret === "2FA_SECRET_HERE") return null;
  try {
    // نستخدم totp-generator إذا كانت مثبّتة
    const totp = require("totp-generator");
    // totp-generator v0.x → totp(secret)
    // totp-generator v1.x → totp.generate(secret)
    const fn = typeof totp === "function" ? totp : totp.generate;
    const code = fn(secret.replace(/\s+/g, "").toUpperCase(), { digits: 6, period: 30 });
    console.log(chalk.cyan("[2FA] ✅ تم توليد رمز TOTP تلقائياً"));
    return String(typeof code === "object" ? code.otp || code.token : code);
  } catch (err) {
    console.warn(chalk.yellow("[2FA] ⚠️ totp-generator غير متاح:", err.message));
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  💾 حفظ AppState على القرص فوراً
// ════════════════════════════════════════════════════════════
function saveAppState(state) {
  const filePath = path.join(__dirname, "appstate.json");
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
    console.log(chalk.green("[SESSION] 💾 appstate.json محفوظ بنجاح"));
  } catch (err) {
    console.error(chalk.red("[SESSION] ❌ فشل حفظ appstate:", err.message));
  }
}

// ════════════════════════════════════════════════════════════
//  🔄 الدالة الموحّدة لتسجيل الدخول (appState أو Email/Password)
// ════════════════════════════════════════════════════════════
function doLogin(credentials, onSuccess) {
  login(credentials, (err, api) => {
    if (!err) return onSuccess(api);

    const errMsg = err?.error || err?.message || String(err);
    console.error(chalk.red("[LOGIN] ❌ فشل تسجيل الدخول:", errMsg));

    // ─── اكتشاف طلب رمز 2FA ─────────────────────────────
    if (err.error === "login-approval" || errMsg.includes("login-approval")) {
      console.log(chalk.yellow("[2FA] ⚡ فيسبوك يطلب رمز التحقق — جاري التوليد التلقائي..."));
      const code = generate2FACode(FB_2FA_SECRET);
      if (code && err.continue) {
        err.continue(code, (err2, api2) => {
          if (!err2) return onSuccess(api2);
          console.error(chalk.red("[2FA] ❌ فشل رمز 2FA:", err2?.message || err2));
          process.exit(1);
        });
        return;
      }
      console.error(chalk.red("[2FA] ❌ لا يوجد مفتاح 2FA أو لا يمكن المتابعة"));
      process.exit(1);
    }

    process.exit(1);
  });
}

// ════════════════════════════════════════════════════════════
//  🚀 تهيئة الـ API بعد نجاح تسجيل الدخول
// ════════════════════════════════════════════════════════════
function onLoginSuccess(api) {
  // ─── إعدادات مقاومة الحظر (Anti-Spam / محاكاة المتصفح) ─
  api.setOptions({
    forceLogin:       true,
    listenEvents:     true,
    updatePresence:   false,
    selfListen:       false,
    online:           true,
    autoMarkRead:     false,
    listenTyping:     false,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  global.botApi = api;

  // ─── حفظ الـ AppState الجديد فوراً بعد تسجيل الدخول ───
  const freshState = api.getAppState();
  if (freshState?.length) {
    saveAppState(freshState);
    global.appState = freshState;
  }

  // ─── تجديد الـ AppState دورياً كل ساعتين (قبل انتهائه) ─
  setInterval(() => {
    try {
      const refreshed = api.getAppState();
      if (refreshed?.length) {
        saveAppState(refreshed);
        global.appState = refreshed;
        console.log(chalk.cyan("[SESSION] 🔄 AppState جُدِّد تلقائياً"));
      }
    } catch (_) {}
  }, 2 * 60 * 60 * 1000);

  startListening(api);

  // ─── تنظيف الذاكرة كل 30 دقيقة ─────────────────────────
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, data] of Object.entries(global.Kagenou.replies)) {
      if (now - (data.timestamp || 0) > 10 * 60 * 1000) {
        delete global.Kagenou.replies[id]; cleaned++;
      }
    }
    for (const [key, exp] of global.userCooldowns.entries()) {
      if (now >= exp) { global.userCooldowns.delete(key); cleaned++; }
    }
    for (const [uid, data] of global.usersData.entries()) {
      if (data._lastSeen && now - data._lastSeen > 60 * 60 * 1000) {
        global.usersData.delete(uid); cleaned++;
      }
    }

    const mem = process.memoryUsage();
    console.log(chalk.cyan(
      `[CLEANUP] 🧹 حُذف ${cleaned} مدخلة | RSS: ${Math.round(mem.rss/1024/1024)}MB` +
      ` | Heap: ${Math.round(mem.heapUsed/1024/1024)}/${Math.round(mem.heapTotal/1024/1024)}MB`
    ));
  }, 30 * 60 * 1000);

}

// ─── Startup ─────────────────────────────────────────────────
const startBot = async () => {
  // ① أول شيء: افتح المنفذ — Render يرفض العملية إذا لم يجد port خلال دقائق
  startWebServer();

  // ✅ اتصال MongoDB — connectDB() تضبط global.db بنفسها
  // (تُعيدها mongoose عند النجاح، أو null عند الفشل/عدم وجود MONGO_URI)
  // ملفات الجلسات (cerebras.js, gemini.js, groq.js, hf.js) تتحقق من global.db قبل الحفظ/القراءة
  await connectDB();

  loadCommands();

  // ════════════════════════════════════════════════════════
  //  محاولة ① — تسجيل الدخول بـ AppState
  // ════════════════════════════════════════════════════════
  const appStateFile  = path.join(__dirname, "appstate.json");
  const hasAppState   = fs.existsSync(appStateFile) || global.appState?.length > 0;

  if (hasAppState) {
    console.log(chalk.blue("[LOGIN] 🔑 جاري تسجيل الدخول بـ AppState..."));

    login({ appState: global.appState }, (err, api) => {
      if (!err) {
        console.log(chalk.green("[LOGIN] ✅ تسجيل الدخول بـ AppState نجح"));
        return onLoginSuccess(api);
      }

      const errMsg = err?.error || err?.message || String(err);

      // ─── طلب 2FA أثناء AppState ────────────────────────
      if (err.error === "login-approval" || errMsg.includes("login-approval")) {
        console.log(chalk.yellow("[2FA] ⚡ AppState يطلب 2FA — جاري التوليد..."));
        const code = generate2FACode(FB_2FA_SECRET);
        if (code && err.continue) {
          err.continue(code, (err2, api2) => {
            if (!err2) {
              console.log(chalk.green("[LOGIN] ✅ 2FA نجح مع AppState"));
              return onLoginSuccess(api2);
            }
            fallbackToEmailLogin(errMsg);
          });
          return;
        }
      }

      // ─── AppState انتهى أو تالف — انتقل للـ Email ──────
      fallbackToEmailLogin(errMsg);
    });

  } else {
    // لا يوجد AppState — ابدأ مباشرة بـ Email/Password
    fallbackToEmailLogin("لا يوجد appstate.json");
  }
};

// ════════════════════════════════════════════════════════════
//  محاولة ② — تسجيل الدخول بـ Email + Password (Fallback)
// ════════════════════════════════════════════════════════════
function fallbackToEmailLogin(reason) {
  console.log(chalk.yellow(`[LOGIN] ⚠️ AppState فشل (${reason?.substring?.(0,80) || reason})`));
  console.log(chalk.blue("[LOGIN] 🔄 الانتقال لتسجيل الدخول بـ Email/Password..."));

  if (!FB_EMAIL || FB_EMAIL === "EMAIL_HERE" ||
      !FB_PASSWORD || FB_PASSWORD === "PASSWORD_HERE") {
    console.error(chalk.red("[LOGIN] ❌ بيانات الدخول (Email/Password) غير مضبوطة في .env أو index.js"));
    process.exit(1);
  }

  doLogin({ email: FB_EMAIL, password: FB_PASSWORD }, (api) => {
    console.log(chalk.green("[LOGIN] ✅ تسجيل الدخول بـ Email/Password نجح"));
    onLoginSuccess(api);
  });
}

startBot();
