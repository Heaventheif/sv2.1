// commands/manga2.js
const axios = require('axios');
const cheerio = require('cheerio');

// إعدادات الإرسال — يمكن تعديلها حسب الحاجة
const BATCH_SIZE = 15;       // عدد الصور كمرفقات في الرسالة الواحدة (حد مسنجر 16)
const BATCH_DELAY_MS = 1500; // تأخير بين كل دفعة والتالية (لتفادي ضغط فيسبوك)
const MAX_IMAGES = 80;       // سقف أمان لعدد الصور المُرسَلة لأي فصل واحد

module.exports = {
  config: {
    name: "manga2",
    aliases: ["مانجا", "m"],
    role: 0,
    countDown: 15,
    category: "وسائط",
    description: "كشط وإرسال صور فصل من مانجا العاشق - استخدم .manga <اسم المانجا> <رقم الفصل>"
  },

  onStart: async ({ api, event, args }) => {
    const { threadID, messageID } = event;

    if (args.length < 2) {
      return api.sendMessage(
        `⚠️ الاستخدام:\n.manga <اسم المانجا> <رقم الفصل>\n\n📌 مثال: .manga one piece 234\n📌 مثال: .manga kingdom 1`,
        threadID,
        messageID
      );
    }

    const chapterNumber = args[args.length - 1];
    const mangaNameParts = args.slice(0, -1);
    const rawMangaName = mangaNameParts.join(' ');
    const initialSlug = mangaNameParts.join('-').toLowerCase();

    const baseUrl = "https://3asq.pro";
    let chapterUrl = `${baseUrl}/manga/${encodeURIComponent(initialSlug)}/${encodeURIComponent(chapterNumber)}/`;

    const commonHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'ar,en-US;q=0.7,en;q=0.3',
    };

    try {
      // ---------- 1) كشط روابط الصور ----------
      const fetchImages = async (url) => {
        const response = await axios.get(url, { timeout: 20000, headers: commonHeaders });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        const $ = cheerio.load(response.data);
        let images = [];
        const selectors = ['.page-break img', '.reading-content img'];
        for (const selector of selectors) {
          const elements = $(selector);
          if (elements.length) {
            elements.each((i, el) => {
              const img = $(el);
              let src = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src');
              if (src) {
                src = src.trim();
                try { images.push(new URL(src, baseUrl).href); }
                catch (e) { /* تجاهل */ }
              }
            });
            if (images.length) break;
          }
        }
        return images;
      };

      let images = await fetchImages(chapterUrl);

      if (images.length === 0) {
        const searchUrl = `${baseUrl}/?s=${encodeURIComponent(rawMangaName)}`;
        const searchRes = await axios.get(searchUrl, { timeout: 10000, headers: commonHeaders });
        const $ = cheerio.load(searchRes.data);
        const firstResult = $('.page-item-detail .item-thumb a').first();
        const href = firstResult.attr('href');
        if (href) {
          const slugMatch = href.match(/\/manga\/([^\/]+)\//);
          if (slugMatch) {
            const correctSlug = slugMatch[1];
            const correctedUrl = `${baseUrl}/manga/${encodeURIComponent(correctSlug)}/${encodeURIComponent(chapterNumber)}/`;
            images = await fetchImages(correctedUrl);
            chapterUrl = correctedUrl;
          }
        }
      }

      if (images.length === 0) {
        return api.sendMessage(
          `❌ لم يتم العثور على أي صور في هذا الفصل.\nتأكد من:\n- اسم المانجا صحيح\n- رقم الفصل صحيح\n- الرابط المحاول: ${chapterUrl}`,
          threadID,
          messageID
        );
      }

      if (images.length > MAX_IMAGES) {
        images = images.slice(0, MAX_IMAGES);
      }

      // ---------- 2) تحويل كل رابط صورة إلى Stream قابل للإرفاق ----------
      // fca-unofficial يقبل stream مباشرة في حقل attachment (لا يقبل روابط نصية).
      const getImageStream = async (url) => {
        const res = await axios.get(url, {
          responseType: 'stream',
          timeout: 20000,
          headers: commonHeaders
        });
        return res.data;
      };

      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      let sentCount = 0;
      let failedCount = 0;

      // ---------- 3) الإرسال على دفعات ----------
      for (let i = 0; i < images.length; i += BATCH_SIZE) {
        const batchUrls = images.slice(i, i + BATCH_SIZE);

        const streams = [];
        for (const url of batchUrls) {
          try {
            const stream = await getImageStream(url);
            streams.push(stream);
          } catch (e) {
            failedCount++;
            console.error('[manga2] فشل تحميل صورة:', url, e.message);
          }
        }

        if (streams.length > 0) {
          try {
            await api.sendMessage(
              { attachment: streams },
              threadID
            );
            sentCount += streams.length;
          } catch (e) {
            failedCount += streams.length;
            console.error('[manga2] فشل إرسال دفعة صور:', e.message);
          }
        }

        // تأخير بسيط بين الدفعات لتفادي ضغط فيسبوك (إن لم تكن آخر دفعة)
        if (i + BATCH_SIZE < images.length) {
          await sleep(BATCH_DELAY_MS);
        }
      }

      // ---------- 4) بلا رسالة ختامية عند النجاح الكامل — الصور هي المخرج النهائي.
      // نُبلّغ فقط عند نقص فعلي في الإرسال.
      if (failedCount > 0) {
        await api.sendMessage(
          `⚠️ فشل تحميل/إرسال ${failedCount} صورة من أصل ${images.length} (روابط بطيئة أو محظورة مؤقتاً).`,
          threadID,
          messageID
        );
      }

    } catch (error) {
      console.error('[manga2] خطأ:', error.message);
      let errorMsg = `❌ حدث خطأ:\n`;
      if (error.code === 'ECONNABORTED') errorMsg += `انتهت المهلة. حاول مرة أخرى.`;
      else if (error.response) errorMsg += `الخادم رد بـ ${error.response.status}`;
      else errorMsg += error.message;
      await api.sendMessage(errorMsg, threadID, messageID);
    }
  }
};
