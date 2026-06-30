"use strict";
// ============================================================
// commands/fb.js — جسر Render → HF
// التحميل كله في HF /fb (fb.py)
// HF يُرجع video_b64 أو خطأ
// إرسال الفيديو يتم هنا في Render
// ============================================================
const axios = require("axios");
const fs    = require("fs-extra");
const os    = require("os");
const path  = require("path");

const HF_BASE = (process.env.HF_SPACE_URL || "https://Solvant-s.hf.space").replace(/\/+$/, "");
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";

const FB_REGEX = /https?:\/\/(www\.)?(facebook\.com|fb\.watch|fb\.com)\/(watch|share|reel|video|reels|[\w.]+\/videos?|[\w.]+\/reels?)[^\s]*/i;

function extractFbUrl(text) {
  return text?.match(FB_REGEX)?.[0] || null;
}

// ─── استدعاء HF ──────────────────────────────────────────────
async function callHF(fbUrl, quality = "worst") {
  const { data } = await axios.post(
    `${HF_BASE}/fb`,
    { url: fbUrl, quality },
    { timeout: 150000, headers: { "Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN } }
  );
  if (data.error) throw new Error(data.error);
  return data;
  // يُرجع: { video_b64, title, size } أو { video_url, title }
}

// ─── تحميل وإرسال ────────────────────────────────────────────
async function downloadAndSend(api, event, fbUrl, quality = "worst", label = "") {
  const { threadID } = event;

  const tmpFile = path.join(os.tmpdir(), `fb_${Date.now()}.mp4`);

  try {
    const result = await callHF(fbUrl, quality);

    if (result.video_b64) {
      // ─── HF حمّل الفيديو وأرجعه base64 ─────────────────
      const buffer = Buffer.from(result.video_b64, "base64");
      await fs.writeFile(tmpFile, buffer);

      await new Promise((res, rej) =>
        global.safeSend(api, 
          { body: `🎬 ${result.title || "فيديو فيسبوك"}${label}`.trim(), attachment: fs.createReadStream(tmpFile) },
          threadID, (err) => err ? rej(err) : res()
        )
      );

    } else if (result.video_url) {
      // ─── HF أرجع رابط مباشر (نادر) ──────────────────────
      await global.safeSend(api, 
        `🎬 ${result.title || "فيديو فيسبوك"}\n🔗 ${result.video_url}`,
        threadID, null, null
      );

    } else {
      console.error("[FB→HF] لم يُعثر على الفيديو:", fbUrl);
    }

  } catch (e) {
    // فشل صامت بالكامل — لا تُرسل أي رسالة في الشات، فقط سجل في الـ console
    console.error("[FB→HF]", e.response?.status, e.message?.substring(0, 200));
  } finally {
    fs.remove(tmpFile).catch(() => {});
  }
}

module.exports = {
  config: {
    name:      "fb",
    aliases:   ["facebook", "fbdl"],
    version:   "3.0.0",
    role:      0,
    countDown: 15,
    category:  "download",
    guide: { en: "{pn} <رابط فيسبوك>\n{pn} hd <رابط> — جودة HD\n💡 أو أرسل الرابط مباشرة بدون أمر!" },
  },

  // ─── كشف رابط تلقائي بدون أمر ──────────────────────────────
  onChat: async ({ api, event }) => {
    let fbUrl = null;
    for (const att of (event.attachments || [])) {
      if (att.type === "share" && att.url) { fbUrl = att.url; break; }
    }
    if (!fbUrl) fbUrl = extractFbUrl(event.body);
    if (!fbUrl && event.messageReply?.body) fbUrl = extractFbUrl(event.messageReply.body);
    if (!fbUrl) return;
    await downloadAndSend(api, event, fbUrl, "worst");
  },

  onStart: async ({ api, event, args, message }) => {
    if (!args[0]) return message.reply(
      "📥 فيسبوك دونلودر\n\n" +
      ".fb <رابط>      — تحميل عادي\n" +
      ".fb hd <رابط>  — جودة HD\n\n" +
      "💡 أو أرسل رابط فيسبوك مباشرة بدون أمر!"
    );
    const wantHD  = args[0].toLowerCase() === "hd";
    const urlArg  = wantHD ? args[1] : args[0];
    const quality = wantHD ? "720p" : "worst";
    if (!urlArg) return message.reply("❌ أرسل الرابط بعد hd.");
    const fbUrl = extractFbUrl(urlArg) || urlArg;
    await downloadAndSend(api, event, fbUrl, quality, wantHD ? " · HD" : "");
  },
};
