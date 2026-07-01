// commands/manga.js
const axios = require('axios');
const cheerio = require('cheerio');

module.exports = {
  config: {
    name: "manga2",
    aliases: ["مانجا", "m"],
    role: 0,
    countDown: 15,
    category: "وسائط",
    description: "كشط صور فصل من مانجا العاشق (3asq.pro) - استخدم .manga <اسم_المانجا> <رقم_الفصل>"
  },

  onStart: async ({ api, event, args }) => {
    const { threadID, messageID } = event;

    if (args.length < 2) {
      return api.sendMessage(
        `⚠️ الاستخدام:\n.manga <اسم المانجا> <رقم الفصل>\n\n📌 مثال: .manga one-piece 234\n📌 مثال: .manga naruto 700`,
        threadID,
        messageID
      );
    }

    const mangaSlug = args[0].toLowerCase();
    const chapterNumber = args[1];
    const baseUrl = "https://3asq.pro";
    const chapterUrl = `${baseUrl}/manga/${encodeURIComponent(mangaSlug)}/${encodeURIComponent(chapterNumber)}/`;

    await api.sendMessage(`🔍 جاري البحث عن الفصل ${chapterNumber} من ${mangaSlug} ...`, threadID, messageID);

    try {
      const response = await axios.get(chapterUrl, {
        timeout: 20000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      if (response.status !== 200) {
        throw new Error(`فشل تحميل الصفحة (HTTP ${response.status})`);
      }

      const $ = cheerio.load(response.data);

      let imageElements = $('.page-break img');
      if (imageElements.length === 0) {
        imageElements = $('.reading-content img');
      }

      if (imageElements.length === 0) {
        return api.sendMessage(
          `❌ لم يتم العثور على أي صور في هذا الفصل.\nتأكد من:\n- اسم المانجا صحيح (مثل one-piece)\n- رقم الفصل صحيح\n- الرابط: ${chapterUrl}`,
          threadID,
          messageID
        );
      }

      const imageUrls = [];
      imageElements.each((index, element) => {
        const img = cheerio(element);
        let src = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src');
        if (src) {
          try {
            imageUrls.push(new URL(src, baseUrl).href);
          } catch (e) { /* تجاهل */ }
        }
      });

      if (imageUrls.length === 0) {
        return api.sendMessage(
          `❌ تم العثور على عناصر صور ولكن بدون روابط صالحة.`,
          threadID,
          messageID
        );
      }

      const total = imageUrls.length;
      const previewLimit = 10;
      let reply = `📖 **مانجا:** ${mangaSlug}\n📄 **الفصل:** ${chapterNumber}\n🖼️ **عدد الصور:** ${total}\n\n`;
      
      imageUrls.slice(0, previewLimit).forEach((url, i) => {
        reply += `${i+1}. ${url}\n`;
      });

      if (total > previewLimit) {
        reply += `\n... و ${total - previewLimit} صورة أخرى`;
      }

      await api.sendMessage(reply, threadID, messageID);

      // معاينة أول صورة
      if (imageUrls.length > 0) {
        await api.sendMessage(`🖼️ معاينة الصفحة الأولى:\n${imageUrls[0]}`, threadID, messageID);
      }

    } catch (error) {
      console.error(`[manga.js] خطأ:`, error.message);
      let errorMsg = `❌ حدث خطأ:\n`;
      if (error.code === 'ECONNABORTED') errorMsg += `انتهت المهلة. حاول مرة أخرى.`;
      else if (error.response) errorMsg += `الخادم رد بـ ${error.response.status}`;
      else errorMsg += error.message;
      await api.sendMessage(errorMsg, threadID, messageID);
    }
  }
};