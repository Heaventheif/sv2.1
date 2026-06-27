"use strict";

const mongoose = require("mongoose");
const chalk    = require("chalk");

let isConnected = false;

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

    console.log(chalk.green("[DB] ✅ MongoDB متصل بنجاح"));

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

function getDB() {
  return mongoose;
}

module.exports = { connectDB, getDB };
