"use strict";

const mongoose = require("mongoose");
const chalk    = require("chalk");
const { UserModel, GlobalDataModel } = require("./schemas");

let isConnected = false;
let _syncInterval = null;

// ════════════════════════════════════════════════════════════
//  ربط global.usersData / global.globalData (Maps في الذاكرة)
//  بقاعدة البيانات: قراءة كسولة (lazy-load) عند أول استخدام،
//  وكتابة دورية مجمّعة (batch) بدل الكتابة عند كل تفاعل — هذا
//  يقلل الضغط على MongoDB مع الحفاظ على استمرارية البيانات.
// ════════════════════════════════════════════════════════════

/**
 * يجلب بيانات مستخدم: من الذاكرة إن وُجدت، وإلا من DB (ويُخزِّنها
 * في الذاكرة بعد الجلب)، وإلا قيمة افتراضية فارغة.
 */
async function getUserData(uid) {
  if (global.usersData.has(uid)) return global.usersData.get(uid);
  let data = { _lastSeen: Date.now() };
  if (global.db) {
    try {
      const doc = await UserModel.findOne({ facebookId: String(uid) }).lean();
      if (doc) data = { ...doc, _lastSeen: Date.now() };
    } catch (e) {
      console.warn(chalk.yellow("[DB] ⚠️ فشل جلب بيانات المستخدم:"), e.message);
    }
  }
  global.usersData.set(uid, data);
  return data;
}

/** يكتب التغييرات المجمّعة من global.usersData إلى MongoDB دفعة واحدة */
async function flushUsersData() {
  if (!global.db || global.usersData.size === 0) return;
  const ops = [];
  for (const [uid, data] of global.usersData.entries()) {
    if (!data || data._dirty !== true) continue;
    const { _lastSeen, _dirty, ...rest } = data;
    ops.push({
      updateOne: {
        filter: { facebookId: String(uid) },
        update: { $set: { ...rest, lastSeen: new Date(_lastSeen || Date.now()) } },
        upsert: true,
      },
    });
    data._dirty = false;
  }
  if (!ops.length) return;
  try {
    await UserModel.bulkWrite(ops, { ordered: false });
    console.log(chalk.cyan(`[DB] 💾 حُفظت ${ops.length} بيانات مستخدم`));
  } catch (e) {
    console.warn(chalk.yellow("[DB] ⚠️ فشل حفظ بيانات المستخدمين دفعة واحدة:"), e.message);
  }
}

/** يكتب global.globalData بالكامل إلى MongoDB (key/value عام) */
async function flushGlobalData() {
  if (!global.db || global.globalData.size === 0) return;
  const ops = [];
  for (const [key, value] of global.globalData.entries()) {
    ops.push({
      updateOne: { filter: { key }, update: { $set: { value } }, upsert: true },
    });
  }
  if (!ops.length) return;
  try {
    await GlobalDataModel.bulkWrite(ops, { ordered: false });
  } catch (e) {
    console.warn(chalk.yellow("[DB] ⚠️ فشل حفظ globalData:"), e.message);
  }
}

/** يحمّل global.globalData من MongoDB عند الإقلاع */
async function loadGlobalData() {
  if (!global.db) return;
  try {
    const docs = await GlobalDataModel.find({}).lean();
    for (const d of docs) global.globalData.set(d.key, d.value);
    console.log(chalk.cyan(`[DB] 📥 حُمِّلت ${docs.length} مدخلة globalData`));
  } catch (e) {
    console.warn(chalk.yellow("[DB] ⚠️ فشل تحميل globalData:"), e.message);
  }
}

async function connectDB() {
  const uri = process.env.MONGO_URI || global.config?.mongoUri;

  if (!uri) {
    console.warn(chalk.yellow("[DB] ⚠️ MONGO_URI غير موجود — البوت سيعمل بدون قاعدة بيانات"));
    global.db = null;
    return;
  }

  if (isConnected) return;

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS:          45000,
      maxPoolSize:              10,
    });

    isConnected = true;
    global.db   = mongoose;

    // أدوات يستخدمها أي ملف command للتفاعل مع الذاكرة/DB بشكل موحّد
    global.getUserData  = getUserData;
    global.markUserDirty = (uid) => {
      const d = global.usersData.get(uid);
      if (d) d._dirty = true;
    };

    console.log(chalk.green("[DB] ✅ MongoDB متصل بنجاح"));
    await loadGlobalData();

    // كتابة دورية مجمّعة كل 5 دقائق بدل الكتابة عند كل تفاعل
    if (_syncInterval) clearInterval(_syncInterval);
    _syncInterval = setInterval(() => {
      flushUsersData().catch(() => {});
      flushGlobalData().catch(() => {});
    }, 5 * 60 * 1000);

    mongoose.connection.on("disconnected", () => {
      isConnected = false;
      console.warn(chalk.yellow("[DB] ⚠️ انقطع الاتصال بـ MongoDB — محاولة إعادة الاتصال..."));
    });

    mongoose.connection.on("reconnected", () => {
      isConnected = true;
      console.log(chalk.green("[DB] ✅ أعيد الاتصال بـ MongoDB"));
    });

    mongoose.connection.on("error", (err) => {
      console.error(chalk.red("[DB] ❌ خطأ في الاتصال:"), err.message);
    });

  } catch (err) {
    console.error(chalk.red("[DB] ❌ فشل الاتصال بـ MongoDB:"), err.message);
    console.warn(chalk.yellow("[DB] البوت سيعمل بدون قاعدة بيانات"));
    global.db = null;
  }
}

/** يُستدعى عند إغلاق البوت لضمان عدم فقد آخر التغييرات غير المحفوظة */
async function flushAllAndDisconnect() {
  await flushUsersData().catch(() => {});
  await flushGlobalData().catch(() => {});
  if (_syncInterval) clearInterval(_syncInterval);
}

module.exports = { connectDB, getUserData, flushUsersData, flushGlobalData, flushAllAndDisconnect };
