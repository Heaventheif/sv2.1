const axios = require('axios');
const fs    = require('fs-extra');
const path  = require('path');
const os    = require('os');

const { sendMoodSticker } = require("../utils/danceSticker.js");

if (!global.soundcloudSearchSessions) global.soundcloudSearchSessions = {};
if (!global.__singCleanupRegistered) {
  global.__singCleanupRegistered = true;
  setInterval(() => {
    const now = Date.now();
    for (const uid in global.soundcloudSearchSessions)
      if (now - global.soundcloudSearchSessions[uid].timestamp > 120000)
        delete global.soundcloudSearchSessions[uid];
  }, 60000);
}

// إيموجي لكل نتيجة (بدل الأرقام)
const TRACK_EMOJIS = ["👍", "❤️","😆","😮","😢", "😡","🥰","🤩"]

function getApiKey() {
  const keys = [process.env.FERDEV_API_KEY, process.env.FERDEV_API_KEY2, process.env.FERDEV_API_KEY3].filter(Boolean);
  return keys.length === 0 ? "FREE" : keys[Math.floor(Math.random() * keys.length)];
}

function getTempPath() {
  return path.join(os.tmpdir(), `sing_${Date.now()}.mp3`);
}

function react() { /* التفاعل مُعطَّل عمداً — البوت يرسل المخرجات النهائية فقط */ }

// بدون رسالة "جارٍ التحميل" — يحذف القائمة بعد الإرسال
async function downloadAndSend(api, threadID, messageID, originMsgID, track, listMsgId = null) {
  const filePath = getTempPath();
  try {
    const dlRes = await axios.get('https://api.ferdev.my.id/downloader/soundcloud', {
      params: { link: track.url, apikey: getApiKey() },
      timeout: 20000,
    });

    const downloadUrl =
      dlRes.data?.result?.downloadUrl ||
      dlRes.data?.result?.url         ||
      dlRes.data?.result?.download_url;

    if (!downloadUrl) throw new Error("لم يُرجع الـ API رابط تحميل.");

    const streamRes = await axios({
      url: downloadUrl, method: 'GET', responseType: 'stream',
      timeout: 90000,
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      streamRes.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    const size = (await fs.stat(filePath)).size;
    if (!size)           throw new Error("الملف فارغ.");
    if (size > 26214400) throw new Error("الملف أكبر من 25MB.");

    await new Promise((resolve, reject) =>
      global.safeSend(api, 
        { body: `🎵 ${track.title}`, attachment: fs.createReadStream(filePath) },
        threadID,
        err => err ? reject(err) : resolve(),
        messageID
      )
    );

    if (listMsgId) { try { await api.unsendMessage(listMsgId, threadID); } catch (_) {} }
    if (originMsgID) react(api, originMsgID, threadID, "✅");
    sendMoodSticker(api, threadID);

  } catch (error) {
    if (originMsgID) react(api, originMsgID, threadID, "❌");
    let msg;
    if (error.message.includes("25MB"))       msg = "⚠️ الملف أكبر من 25MB.";
    else if (error.code === 'ECONNABORTED')   msg = "❌ انتهت مهلة التحميل.";
    else if (error.message.includes("يُرجع")) msg = "❌ فشل الـ API في إرجاع رابط التحميل.";
    else                                      msg = "❌ فشل التحميل، قد يكون المحتوى محمياً.";
    global.safeSend(api, msg, threadID, null, messageID);
  } finally {
    fs.remove(filePath).catch(() => {});
  }
}

module.exports = {
  config: {
    name:     "sing",
    version:  "5.2.0",
    countDown: 5,
    role:     0,
    description: "بحث وتحميل أغاني من SoundCloud — أضف s لعرض قائمة نتائج",
    category: "media",
    guides:   "sing [اسم] | sing s [اسم]",
  },

  onChat: async function({ api, event, message }) {
    const { threadID, senderID, body, messageID } = event;
    if (!body) return;

    const trimmed = body.trim();
    const lower   = trimmed.toLowerCase();
    const TRIGGERS = ['sing ', 'mp3 ', 'song ', 'اغنية ', 'أغنية '];
    const trigger  = TRIGGERS.find(t => lower.startsWith(t));

    if (!trigger) {
      // اختيار من قائمة بالإيموجي
      const session = global.soundcloudSearchSessions[senderID];
      if (!session) return;

      const idx = TRACK_EMOJIS.indexOf(trimmed.trim());
      if (idx === -1) return;

      if (Date.now() - session.timestamp > 120000) {
        delete global.soundcloudSearchSessions[senderID];
        return message.reply("⏳ انتهت الجلسة، ابحث مجدداً.");
      }
      if (idx >= session.results.length) return;

      const chosenTrack = session.results[idx];
      const originMsgID = session.originMsgID;
      const listMsgId   = session.listMsgId;
      delete global.soundcloudSearchSessions[senderID];

      if (originMsgID) react(api, originMsgID, threadID, "🤖");
      await downloadAndSend(api, threadID, messageID, originMsgID, chosenTrack, listMsgId);
      return;
    }

    const rest      = trimmed.slice(trigger.length).trim();
    const showList  = rest.toLowerCase().startsWith("s ");
    const songName  = showList ? rest.slice(2).trim() : rest;
    if (!songName) return message.reply("❌ مثال: sing shape of you");

    react(api, messageID, threadID, "🤖");

    try {
      const res = await axios.get('https://api.ferdev.my.id/search/soundcloud', {
        params: { query: songName, apikey: getApiKey() },
        timeout: 20000,
      });

      const items = res.data?.result || [];
      if (items.length === 0) {
        react(api, messageID, threadID, "❌");
        return global.safeSend(api, "❌ لم يتم العثور على نتائج.", threadID, null, messageID);
      }

      const allTracks = [];
      items.slice(0, 7).forEach(track => {
        const title = track.title || `أغنية ${allTracks.length + 1}`;
        const url   = track.url || track.permalink_url || track.link;
        if (url) allTracks.push({ title, url });
      });

      if (allTracks.length === 0) {
        react(api, messageID, threadID, "❌");
        return global.safeSend(api, "❌ فشل استخراج الروابط.", threadID, null, messageID);
      }

      if (!showList) {
        react(api, messageID, threadID, "✅");
        return await downloadAndSend(api, threadID, messageID, messageID, allTracks[0]);
      }

      // قائمة بالإيموجي
      let msg = `🎵 نتائج البحث:\n${"─".repeat(22)}\n`;
      allTracks.forEach((t, i) => {
        msg += `${TRACK_EMOJIS[i]} ${t.title}\n${"─".repeat(22)}\n`;
      });
      msg += `تفاعل بالإيموجي لاختيار الأغنية\n⏳ تنتهي بعد دقيقتين.`;

      const sent = await new Promise((res, rej) =>
        global.safeSend(api, msg, threadID, (err, info) => err ? rej(err) : res(info), messageID)
      );

      global.soundcloudSearchSessions[senderID] = {
        results: allTracks,
        timestamp: Date.now(),
        originMsgID: messageID,
        listMsgId: sent?.messageID || null,
      };

      // أيضاً يستمع للتفاعل على رسالة القائمة
      if (sent?.messageID && global.client?.reactionListener) {
        global.client.reactionListener[sent.messageID] = {
          author: event.senderID,
          callback: async ({ api, event: re }) => {
            const idx = TRACK_EMOJIS.indexOf(re.reaction);
            if (idx === -1 || idx >= allTracks.length) return;

            delete global.client.reactionListener[sent.messageID];
            delete global.soundcloudSearchSessions[senderID];

            react(api, messageID, threadID, "🤖");
            await downloadAndSend(api, threadID, messageID, messageID, allTracks[idx], sent.messageID);
          },
        };
        setTimeout(() => {
          delete global.client?.reactionListener?.[sent.messageID];
          delete global.soundcloudSearchSessions[senderID];
        }, 120000);
      }

      react(api, messageID, threadID, "✅");

    } catch (error) {
      react(api, messageID, threadID, "❌");
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout'))
        return global.safeSend(api, "❌ انتهت مهلة البحث، حاول مرة أخرى.", threadID, null, messageID);
      global.safeSend(api, "❌ خطأ أثناء البحث.", threadID, null, messageID);
    }
  },
};