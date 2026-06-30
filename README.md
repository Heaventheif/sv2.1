# 🤖 SunkenBot — منظومة بوت متعددة الاستضافة (Render + Hugging Face)

<div align="center">

**بوت فيسبوك ماسنجر مدعوم بطبقة API موحّدة من خدمات الذكاء الاصطناعي والوسائط**

![Node.js](https://img.shields.io/badge/Node.js-22.x-green?logo=node.js)
![Python](https://img.shields.io/badge/Python-3.11-blue?logo=python)
![FastAPI](https://img.shields.io/badge/FastAPI-latest-009688?logo=fastapi)
![Render](https://img.shields.io/badge/Render-Userbot-46E3B7?logo=render)
![HuggingFace](https://img.shields.io/badge/HuggingFace-API%20Space-yellow?logo=huggingface)
![License](https://img.shields.io/badge/License-MIT-lightgrey)

</div>

---

## 📋 نظرة عامة على المنظومة

المشروع مكوَّن من **مكوّنين منفصلين يعملان معاً**، كل واحد على استضافة مختلفة:

| المكوّن | المستودع | الاستضافة | الدور |
|---|---|---|---|
| **SunkenBot v2.1** | `sv2.1` | **Render** (Node.js Web Service) | بوت Userbot يسجّل دخولاً لحساب فيسبوك ويتفاعل داخل المجموعات بالأوامر |
| **Sunken Bot API** | `hf-space` | **Hugging Face Spaces** (Docker) | خادم FastAPI موحَّد يقدّم كل خدمات الذكاء الاصطناعي والوسائط عبر نظام plugins |

```
مستخدم في مجموعة فيسبوك
        │  (.gemini, .yt, .chess ...)
        ▼
SunkenBot v2.1  (Render — Node.js Userbot)
        │  HTTP POST + header: X-Internal-Token
        ▼
Sunken Bot API  (Hugging Face Space — FastAPI)
        │
        ├── Groq / Gemini / GPT-4o / Cerebras / HF Inference
        ├── تحميل فيديو فيسبوك، يوتيوب، SoundCloud
        ├── شطرنج، قرآن، روايات، ترجمة، صور...
        ▼
الرد يعود إلى البوت على Render → يُرسل للمجموعة
```

البوت على **Render** هو الواجهة التي يتعامل معها المستخدمون مباشرة داخل فيسبوك، بينما **Hugging Face Space** يعمل كـ Backend داخلي يقدّم كل المنطق الثقيل (نماذج AI، كشط الوسائط، إلخ) عبر REST API. الفصل بين الاثنين يسمح بتحديث/توسعة كل جزء بشكل مستقل، لكنه يفرض ضرورة **تأمين القناة بينهما** — وهذا هو محور التحديث الموثّق أدناه.

---

## 🔐 تحديث الأمان: حماية API الداخلي بـ X-Internal-Token

نظراً لأن Hugging Face Space يُعرَّض كنقطة HTTP عامة (حتى لو لم يُروَّج لها)، فإن أي شخص يعرف رابط الـ Space يستطيع نظرياً استدعاء كل الـ endpoints مباشرة (نماذج AI، تحميل وسائط، إلخ) دون المرور بالبوت على Render. لإغلاق هذه الثغرة أُضيف middleware عام في طبقة FastAPI.

### كيف يعمل

- **Middleware عام بـ FastAPI** مُسجَّل على مستوى التطبيق بالكامل (`plugin_loader.py`، عبر `_register_auth_middleware`)، يتحقق من وجود الـ header **`X-Internal-Token`** على **كل طلب وارد**.
- **استثناءان فقط ومتعمَّدان**: `/` و `/health`. هذان المساران يبقيان عامّين دائماً (بلا توكن) حتى تستمر فحوصات الحالة العامة (health checks من Render/HF/أدوات المراقبة) بالعمل لأي جهة، دون أن تكشف أي معلومة حساسة أصلاً (مجرد حالة "online/healthy").
- **مصدر التوكن**: متغيّر بيئة باسم **`INTERNAL_TOKEN`** يُضبط من طرفك في:
  > **HF Space → Settings → Variables and secrets → New secret**
- **سلوك آمن افتراضياً عند عدم الضبط (Fail-Open مع تحذير)**: إذا لم تضع `INTERNAL_TOKEN` إطلاقاً، الـ middleware **لا يُسجَّل أصلاً** والخدمة تستمر بالعمل بسلوكها القديم بدون أي حماية — لكن مع تحذير صريح في الـ logs:
  ```
  ⚠️ INTERNAL_TOKEN غير مضبوط — كل الـ endpoints مفتوحة بدون حماية!
  أضف INTERNAL_TOKEN في إعدادات الـ Space (Settings → Variables and secrets).
  ```
  هذا التصميم مقصود: يمنع توقف الخدمة بالكامل (Fail-Closed) في حال نسيت ضبط المتغير قبل أول deploy، بثمن تحذير واضح بدل فشل صامت أو خدمة معطّلة بالكامل.
- **عند ضبط `INTERNAL_TOKEN`**: أي طلب على أي مسار غير المستثنيين يجب أن يحمل الـ header الصحيح، وإلا يُرفض فوراً بـ:
  ```http
  HTTP/1.1 401 Unauthorized
  Content-Type: application/json

  {"status": "error", "message": "Unauthorized — missing or invalid X-Internal-Token"}
  ```
  كل محاولة مرفوضة تُسجَّل في الـ logs مع الـ method والمسار وعنوان IP المرسِل.

### إعداد الطرفين

**1) على Hugging Face Space (الخادم):**

| المتغير | الاستخدام |
|---|---|
| `INTERNAL_TOKEN` | سرّ مشترك يتحقق منه الـ middleware على كل طلب (عدا `/` و `/health`) |

أضِفه كـ **secret** (وليس variable عادي) حتى لا يظهر قيمته في واجهة الإعدادات أو السجلات.

**2) على Render (البوت — العميل):**

| المتغير | الاستخدام |
|---|---|
| `INTERNAL_TOKEN` | نفس القيمة بالضبط الموضوعة في HF Space، يرسلها البوت تلقائياً كـ header `X-Internal-Token` مع كل طلب إلى الـ API |

البوت على جانب Render يقرأ نفس المتغيّر ويُرفقه تلقائياً عند استدعاء أي endpoint في الـ Space (مثل `/groq`, `/gemini`, `/process_move`, `/fb`, `/novel`...)، عبر:
```js
headers: { "Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN }
```

> ⚠️ **مهم:** التوكن يجب أن يكون **مطابقاً تماماً** على الاستضافتين. أي اختلاف (حتى مسافة زائدة) يعني أن كل طلبات البوت سترجع 401.

> 💡 إن غيّرت `INTERNAL_TOKEN` لاحقاً، حدِّثه في **كلا** الاستضافتين معاً (Render + HF Space) وأعد نشر/إعادة تشغيل الخدمتين، وإلا سينقطع الاتصال بين البوت والـ API.

---

## 🧩 1) Sunken Bot API — الخادم على Hugging Face Space

خادم API موحَّد مبني على **FastAPI**، يُنشَر كصورة **Docker** على Hugging Face Spaces ويُزامَن تلقائياً من GitHub. بنيته قائمة على نظام **plugins** قابل للتوسعة: كل ميزة هي ملف Python واحد في `plugins/` دون أي تعديل على `main.py` نفسه.

### أبرز الخدمات المتاحة عبره

- **ذكاء اصطناعي**: `/groq` (Llama 4 Scout)، `/gemini` (Gemini 2.5 Flash + Google Search Grounding)، `/gptx` (GPT-4o)، `/cerebras` (GPT-OSS)، `/hf` (20+ نموذج عبر HF Inference)
- **وسائط**: `/image` (توليد صور FLUX/SDXL)، `/pinterest` (بحث صور)، `/sing` (SoundCloud)، `/fb` (تحميل فيديو فيسبوك)، `/random` (Tumblr)، `/stickers/mood`
- **ألعاب ومحتوى**: `/process_move` (محرك شطرنج)، `/novel/*` (قراءة روايات من 5 مصادر)، `/quran`، `/translate`
- **معلومات عامة**: `/` (حالة الخادم وقائمة plugins المحمَّلة) و`/health` (فحص صحة) — **هذان فقط مستثنيان من حماية التوكن**

كل الـ endpoints الأخرى أعلاه تمر الآن إلزامياً عبر middleware التحقق من `X-Internal-Token` الموضّح في القسم السابق.

### متغيرات البيئة (HF Space → Settings → Variables and secrets)

هذه هي القائمة الفعلية المضبوطة حالياً على الـ Space (Settings → Variables and secrets):

**Variables (عامة):**

| المتغير | الاستخدام |
|---|---|
| `GROQ_API_KEY` | Llama 4 Scout + Whisper + fallback لـ Gemini |
| `GEMINI_API_KEY` | Gemini 2.5 Flash — المفتاح الأساسي |
| `GEMINI_API_KEY_2` | مفتاح Gemini إضافي (تناوب عند نفاد الحصة) |
| `GEMINI_API_KEY_3` | مفتاح Gemini إضافي (تناوب عند نفاد الحصة) |
| `MONGO_URI` | حفظ جلسات المحادثة لكل `thread_id` |

**Secrets (سرية):**

| المتغير | الاستخدام |
|---|---|
| `INTERNAL_TOKEN` | حماية كل الـ API بتوكن داخلي (راجع قسم الأمان أعلاه) |

> ℹ️ متغيرات أخرى يدعمها الكود لخدمات اختيارية غير مفعّلة حالياً على هذا الـ Space (يمكن إضافتها لاحقاً عند الحاجة): `GEMINI_API_KEY_4`، `HF_TOKEN` (لـ `/hf` و `/image`)، `GITHUB_MODELS_TOKEN` (لـ `/gptx`)، `CEREBRAS_API_KEY` (لـ `/cerebras`)، `TUMBLR_API_KEY` (لـ `/random`)، `GIPHY_API_KEY` (لـ `/stickers/mood`)، `FERDEV_API_KEY` (لـ `/sing` و `/pinterest`)، `CF_WORKER_URL` (توجيه عبر Cloudflare Worker).
>
> ⚠️ **تذكير حاسم**: `INTERNAL_TOKEN` يجب أن يُضاف كـ **Secret** وليس Variable عادي — الـ Secrets فقط تبقى مخفية القيمة في واجهة الإعدادات وفي السجلات.

### النشر والتشغيل

```bash
git clone https://github.com/your-username/hf-space.git
cd hf-space
cp .env.example .env   # عدّل القيم، ومنها INTERNAL_TOKEN
docker build -t sunken-bot .
docker run -p 7860:7860 --env-file .env sunken-bot
```

ينشر تلقائياً عبر GitHub Action عند كل `push` إلى `main` (`sync.yml`)، مع `keep-alive.yml` يومي لإبقاء الـ Space نشطاً.

---

## 🧩 2) SunkenBot v2.1 — البوت على Render

بوت Node.js يعمل كـ **Userbot** داخل مجموعات فيسبوك ماسنجر (عبر `@dongdev/fca-unofficial`)، وينفّذ الأوامر بالاتصال بخادم Sunken Bot API على Hugging Face.

> ⚠️ **تذكير**: تسجيل الدخول غير الرسمي يخالف شروط استخدام فيسبوك بحد ذاته — استخدم دائماً حساباً مخصصاً للبوت وليس حسابك الشخصي.

### أبرز حمايات هذه النسخة

- طابور إرسال (`safeSend`) **منفصل لكل مجموعة (threadID)** بدل طابور عام واحد.
- كل استدعاء `api.sendMessage` يمر تلقائياً عبر `safeSend` (تغليف `api` في `index.js`).
- `.adduser`: cooldown مرفوع إلى 45 ثانية + حد أقصى **8 إضافات/يوم لكل مشرف**.
- **Rate limiting عام لكل مستخدم**: 5 أوامر كحد أقصى كل 10 ثوانٍ.
- ربط فعلي لـ `usersData`/`globalData` بـ MongoDB (قراءة كسولة + كتابة دورية كل 5 دقائق)، مع إغلاق سليم (graceful shutdown) عند `SIGTERM`/`SIGINT`.
- إرسال `X-Internal-Token` تلقائياً مع كل طلب إلى الـ API على Hugging Face (راجع قسم الأمان أعلاه).

### أبرز الأوامر

| الفئة | أمثلة |
|---|---|
| ذكاء اصطناعي | `.gemini`، `.groq`، `.cerebras`، `.gptx`، `.hf` |
| وسائط | `.yt`، `.yt2`، `.ydl`، `.sc`، `.sing`، `.tts`، `.pinterest` |
| ألعاب ومحتوى | `.chess`، `.novel`، `.quran`، `.catfact`، `.random` |
| أدوات عامة | `.help`، `.tr`، `.uid`، `.gid`، `.profile` |
| إدارة (مشرفين) | `.kick`، `.adduser` |

### متغيرات البيئة (Render → Environment Variables)

القائمة الكاملة المطلوبة (مطابقة لملف `.env` المستخدَم على الخدمة):

| المتغير | الاستخدام |
|---|---|
| `INTERNAL_TOKEN` | نفس قيمة HF Space — يُرفق تلقائياً كـ `X-Internal-Token` مع كل طلب للـ API |
| `APPSTATE` | جلسة دخول فيسبوك بصيغة JSON (بديل/مكمّل لـ `FB_EMAIL`/`FB_PASSWORD`) |
| `FB_EMAIL` | بريد حساب فيسبوك الخاص بالبوت |
| `FB_PASSWORD` | كلمة مرور حساب فيسبوك الخاص بالبوت |
| `FB_2FA_SECRET` | مفتاح التحقق بخطوتين (إن كان الحساب يستخدم 2FA) |
| `MONGO_URI` | قاعدة بيانات لحفظ بيانات المستخدمين والجلسات بشكل دائم (موصى بها بشدة) |
| `HF_SPACE_URL` | رابط Hugging Face Space (الـ API الذي يستدعيه البوت) |
| `GEMINI_API_KEY` / `GEMINI_API_KEY_2` / `GEMINI_API_KEY_3` / `GEMINI_API_KEY_4` | مفاتيح Gemini للأوامر التي تستدعيه مباشرة من البوت |
| `CEREBRAS_API_KEY` | الاتصال بـ Cerebras GPT-OSS |
| `SAMBANOVA_API_KEY` | مزوّد ذكاء اصطناعي إضافي (SambaNova) |
| `GITHUB_MODELS_TOKEN` | GPT-4o عبر GitHub Models |
| `FERDEV_API_KEY` / `FERDEV_API_KEY2` / `FERDEV_API_KEY3` | مفاتيح خدمة Ferdev (SoundCloud / Pinterest وغيرها) — بديلة لبعضها عند نفاد الحصة |
| `GIPHY_API_KEY` | GIFs المزاجية (`.sing` / ستيكر الأغنية) |
| `TUMBLR_API_KEY` | محتوى عشوائي من Tumblr (`.random`) |
| `RENDER_API_KEY` | الوصول إلى Render API (مثلاً لإعادة تشغيل الخدمة برمجياً) |
| `RENDER_EXTERNAL_URL` | الرابط العام للخدمة على Render (يُستخدم في keep-alive/health checks) |
| `RENDER_SERVICE_ID` | معرّف الخدمة على Render (يُستخدم مع `RENDER_API_KEY`) |

> 💡 انسخ `sv2.1.env.txt` إلى `.env` على جذر مشروع `sv2.1` واملأ القيم؛ لا حاجة لإضافة أي متغيّر غير موجود في هذه القائمة.

### النشر على Render

1. ارفع الكود على GitHub (**بدون** `.env`).
2. أنشئ Web Service جديد على [render.com](https://render.com).
3. أضف متغيرات البيئة أعلاه من **Environment Variables** (تأكد أن `INTERNAL_TOKEN` مطابق لقيمته في HF Space).
4. أمر التشغيل: `node index.js` — Node.js: `22`.

### التشغيل محلياً

```bash
npm install
cp .env.example .env   # عدّل القيم، ومنها INTERNAL_TOKEN لمطابقة HF Space
npm start
```

---

## ➕ إضافة أمر/ميزة جديدة — الصيغة المطلوبة في كل مستودع

كلا المشروعين يستخدمان نظام **auto-discovery**: ضَع ملفاً بصيغة مُحدَّدة في المجلد الصحيح، وسيكتشفه النظام تلقائياً عند الإقلاع التالي دون أي تعديل على الكود الأساسي. الصيغة مختلفة بين المشروعين لأن أحدهما Python/FastAPI (Endpoint) والآخر Node.js (أمر شات).

### 1) في `hf-space` (Hugging Face) — إضافة Plugin/Endpoint جديد

أنشئ ملفاً جديداً في `plugins/`، مثلاً `plugins/my_feature.py`. الصيغة التي **يجب** أن يكتبها النظام ليقرأها `plugin_loader.py`:

```python
# plugins/my_feature.py
"""
plugins/my_feature.py
endpoint: POST /my-endpoint
وصف مختصر لما يفعله هذا الـ plugin (تعليق توثيقي أعلى الملف — ليس إلزامياً للتشغيل لكنه موصى به)
"""

from fastapi import Request
from fastapi.responses import JSONResponse

# تعريف إلزامي يقرأه main.py/`GET /` لعرضه في قائمة الـ plugins
DESCRIPTION = "وصف مختصر للـ plugin يظهر في GET /"

# اختياري — حزم pip إضافية يحتاجها هذا الـ plugin فقط
# (أنشئ أيضاً ملف plugins/requirements/my_feature.txt بنفس الأسماء)
# يُثبَّت تلقائياً عند الإقلاع ويُضاف لـ requirements.txt الجذر

# اختياري — حزم نظام (apt) يحتاجها هذا الـ plugin، تُضاف تلقائياً إلى Dockerfile
DOCKERFILE_DEPS = ["ffmpeg"]


def register(app):
    """
    دالة إلزامية بهذا الاسم بالضبط: register(app) — أو setup(app) كبديل مقبول.
    هنا تُعرَّف كل الـ routes الخاصة بهذا الـ plugin على تطبيق FastAPI.
    """

    @app.post("/my-endpoint")
    async def my_endpoint(request: Request):
        body = await request.json()
        # ... منطق المعالجة هنا
        return JSONResponse({"status": "ok"})
```

**القواعد التي يفرضها `plugin_loader.py` عند القراءة:**

| العنصر | الإلزامية | الدور |
|---|---|---|
| اسم الملف لا يبدأ بـ `_` | إلزامي | الملفات التي تبدأ بـ `_` (مثل `_base.py`) تُتجاهَل عمداً |
| دالة `register(app)` أو `setup(app)` | إلزامي (واحدة على الأقل) | نقطة الدخول التي يستدعيها المُحمِّل لتسجيل الـ routes |
| `DESCRIPTION` (نص) | موصى به | يظهر في استجابة `GET /` ضمن قائمة الـ plugins المحمَّلة |
| `DOCKERFILE_DEPS` (قائمة نصوص) | اختياري | حزم apt تُدمج تلقائياً في `Dockerfile` |
| `plugins/requirements/<name>.txt` | اختياري | مكتبات pip خاصة بالـ plugin، تُثبَّت وتُدمج تلقائياً في `requirements.txt` |

- **لا تُعدِّل** `main.py` أو `plugin_loader.py` أبداً — كل إضافة تتم فقط عبر ملف جديد في `plugins/`.
- فشل تحميل plugin واحد (خطأ استيراد، فشل تثبيت متطلبات...) **لا يوقف** بقية الـ plugins ولا الخادم؛ يظهر فقط كـ `"status": "error"` في `GET /`.
- لا حاجة لإضافة الـ endpoint الجديد يدوياً لأي قائمة — يُكتشف تلقائياً من مجرد وجود الملف.
- تذكَّر أن أي endpoint جديد هنا سيمر تلقائياً عبر **middleware التحقق من `X-Internal-Token`** (ما لم يكن `/` أو `/health`)، فلا حاجة لإضافة تحقق توكن يدوي داخل الـ plugin نفسه.

### 2) في `sv2.1` (Render) — إضافة أمر شات جديد

أنشئ ملفاً جديداً في `commands/`، مثلاً `commands/mycommand.js`. الصيغة التي **يجب** أن يكتبها النظام ليقرأها مُحمِّل الأوامر في `index.js`:

```js
// commands/mycommand.js
module.exports = {
  config: {
    name: "mycommand",        // إلزامي — اسم الأمر كما يُكتب بعد الـ Prefix (مثلاً .mycommand)
    aliases: ["alias1"],      // اختياري — أسماء بديلة لنفس الأمر
    role: 0,                  // إلزامي — 0 = للجميع، 1 = مشرفين، 2 = مشرف كبير، 3 = VIP، 4 = مطور
    countDown: 5,             // اختياري (افتراضي بسيط) — مهلة التبريد بالثواني بين استخدامين لنفس المستخدم
    category: "أدوات",        // اختياري — التصنيف الذي يظهر تحته في .help
    description: "وصف مختصر لما يفعله الأمر", // يظهر في .help [اسم الأمر]
  },

  // دالة إلزامية بهذا الاسم بالضبط: onStart
  onStart: async ({ api, event, args }) => {
    const { threadID, messageID } = event;
    // args = الكلمات بعد اسم الأمر، مثال: ".mycommand مرحبا" → args = ["مرحبا"]

    // استخدم api.sendMessage عادي — يمر تلقائياً عبر طابور safeSend الآمن لكل مجموعة
    await api.sendMessage("مرحباً! الأمر شغال ✅", threadID, messageID);
  }
};
```

**القواعد التي يفرضها مُحمِّل الأوامر عند القراءة:**

| العنصر | الإلزامية | الدور |
|---|---|---|
| الملف داخل `commands/*.js` | إلزامي | أي ملف JS هنا يُحمَّل تلقائياً عند تشغيل البوت — لا حاجة لتسجيله يدوياً في `index.js` |
| `module.exports.config.name` | إلزامي | يحدد كيف يُستدعى الأمر (`<Prefix><name>`، مثل `.mycommand`) |
| `module.exports.config.role` | إلزامي | يحدد من يملك صلاحية تنفيذ الأمر حسب نظام الصلاحيات (0–4) |
| `module.exports.onStart` | إلزامي | الدالة التي تُنفَّذ فعلياً عند استدعاء الأمر — تستقبل `{ api, event, args }` |
| `aliases` / `countDown` / `category` / `description` | اختياري | تحسّن تجربة `.help` وتمنع إساءة الاستخدام، لكن الأمر يعمل بدونها بإعدادات افتراضية |

- إن احتاج الأمر استدعاء API على Hugging Face Space، استورد `INTERNAL_TOKEN` من البيئة وأرفقه كـ header، بنفس نمط `commands/groq.js` أو `commands/gemini.js`:
  ```js
  const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";
  // ...
  axios.post(`${process.env.HF_SPACE_URL}/my-endpoint`, payload,
    { headers: { "Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN } });
  ```
- لا تستدعِ `api.sendMessage` بأي شكل آخر غير ما هو موضّح أعلاه؛ التغليف التلقائي في `index.js` يضمن مرور كل الرسائل عبر طابور الإرسال الآمن (`safeSend`) لحماية الحساب من الحظر — وهذا يعمل تلقائياً طالما استخدمت `api.sendMessage` العادية كما في المثال.

---

## 🗺️ مرجع سريع للمصادر

| الموضوع | أين تجده |
|---|---|
| تفاصيل كل endpoint في الـ API (أمثلة JSON كاملة) | `hf-space/README.md` |
| تفاصيل كل أمر في البوت ونظام الصلاحيات | `sv2.1/README.md` |
| كود الـ middleware الأمني | `hf-space/plugin_loader.py` (`_register_auth_middleware`) |
| استدعاء التوكن من جهة البوت | `sv2.1/commands/*.js` (مثل `groq.js`, `gemini.js`, `fb.js`, `chess.js`, `novel2.js`) |

---

## 📜 الترخيص

كلا المشروعين مرخَّصان بموجب رخصة **MIT**.
