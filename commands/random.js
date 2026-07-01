const axios = require("axios");
const fs    = require("fs");
const path  = require("path");
const os    = require("os");

const TUMBLR_API_KEY = process.env.TUMBLR_API_KEY || "";

const VIDEO_BLOGS = [
  "videohall", "gifak-net", "sizvideos", "pleatedjeans",
  "tastefullyoffensive", "humortrain", "best-of-tumblr-daily",
  "videogifs", "funnyordie", "motionaddicts",
  "catasters", "kittens", "there-is-always-hope",
  "awesome-picz", "thefrogman",
];

function react() { /* التفاعل مُعطَّل عمداً — البوت يرسل المخرجات النهائية فقط */ }

module.exports = {
  config: {
    name: "random",
    aliases: ["tb", "tumblr", "فيديو"],
    version: "1.2.0",
    countDown: 15,
    role: 0,
    shortDescription: { ar: "فيديو عشوائي من Tumblr" },
    category: "media",
    guide: { ar: "{pn}random ← فيديو عشوائي تماماً" }
  },

  onStart: async function ({ api, event }) {
    const { threadID, messageID } = event;

    if (!TUMBLR_API_KEY)
      return global.safeSend(api, "⚠️ TUMBLR_API_KEY غير مضبوط", threadID, null, messageID);

    react(api, messageID, threadID, "🤖");
    const tmpFile = path.join(os.tmpdir(), `tumblr_${Date.now()}.mp4`);

    try {
      let videoUrl = null, postUrl = null, blogName = null, caption = null;
      const shuffled = [...VIDEO_BLOGS].sort(() => Math.random() - 0.5);

      for (const blog of shuffled) {
        try {
          const offset   = Math.floor(Math.random() * 20);
          const response = await axios.get(
            `https://api.tumblr.com/v2/blog/${blog}/posts/video`,
            { params: { api_key: TUMBLR_API_KEY, limit: 20, offset }, timeout: 8000 }
          );
          const posts = response.data?.response?.posts || [];
          if (!posts.length) continue;
          const post = posts[Math.floor(Math.random() * posts.length)];
          const url  = post.video_url
            || post.player?.find(p => p.width >= 400)?.embed_code
            || post.player?.[0]?.embed_code;
          if (!url || !url.startsWith("http")) continue;
          videoUrl = url;
          postUrl  = post.post_url || "";
          blogName = blog;
          caption  = (post.summary || post.caption || "").replace(/<[^>]*>/g, "").trim().substring(0, 100);
          break;
        } catch (_) { continue; }
      }

      if (!videoUrl) {
        react(api, messageID, threadID, "❌");
        return global.safeSend(api, "❌ لم أجد فيديو الآن — حاول مرة أخرى", threadID, null, messageID);
      }

      const dlResponse = await axios.get(videoUrl, {
        responseType: "stream", timeout: 60000,
        headers: { "User-Agent": "Mozilla/5.0" },
        validateStatus: () => true,
      });

      if (dlResponse.status !== 200) {
        react(api, messageID, threadID, "✅");
        return global.safeSend(api, 
          `🎬 ${caption || "فيديو عشوائي"}\n📺 @${blogName}\n\n🔗 ${postUrl}`,
          threadID, null, messageID
        );
      }

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tmpFile);
        dlResponse.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      const sizeMB = fs.statSync(tmpFile).size / (1024 * 1024);

      if (sizeMB < 0.01) {
        react(api, messageID, threadID, "❌");
        return global.safeSend(api, "❌ الفيديو فارغ — حاول مرة أخرى", threadID, null, messageID);
      }

      if (sizeMB > 25) {
        react(api, messageID, threadID, "✅");
        return global.safeSend(api, 
          `🎬 ${caption || "فيديو عشوائي"}\n📺 @${blogName}\n💾 ${sizeMB.toFixed(1)}MB\n\n🔗 ${postUrl}`,
          threadID, null, messageID
        );
      }

      await new Promise((resolve, reject) =>
        global.safeSend(api, 
          { body: `🎬 ${caption || "فيديو عشوائي"}\n📺 @${blogName}`, attachment: fs.createReadStream(tmpFile) },
          threadID, (err) => err ? reject(err) : resolve(), messageID
        )
      );

      react(api, messageID, threadID, "✅");

    } catch (error) {
      react(api, messageID, threadID, "❌");
      let errMsg = "❌ فشل جلب الفيديو\n";
      if (error.response?.status === 401)     errMsg += "🔑 API Key غير صالح";
      else if (error.response?.status === 429) errMsg += "⚠️ تجاوزت حد الطلبات";
      else if (error.code === "ECONNABORTED")  errMsg += "⏱ انتهت مهلة الانتظار";
      else errMsg += error.message?.substring(0, 150) || "خطأ غير معروف";
      global.safeSend(api, errMsg, threadID, null, messageID);
    } finally {
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
};
