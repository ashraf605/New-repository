// index.js

const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require('fs').promises; // لاستخدام نظام الملفات كقاعدة بيانات
require("dotenv").config();

// --- إعدادات أساسية ---
const DB_FILE = './db.json'; // اسم ملف قاعدة البيانات

const requiredEnv = [
  "TELEGRAM_BOT_TOKEN",
  "OKX_API_KEY",
  "OKX_API_SECRET_KEY",
  "OKX_API_PASSPHRASE",
  "AUTHORIZED_USER_ID"
];
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    console.error(`!!! متغير البيئة ${envVar} غير موجود.`);
  }
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || "");
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0", 10);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(`/${bot.token}`, webhookCallback(bot, "express"));

app.get("/", (req, res) => res.send("OKX Bot Pro is running!"));

// --- إدارة قاعدة البيانات (ملف JSON) ---
let db;

async function initDb() {
    try {
        await fs.access(DB_FILE);
        const data = await fs.readFile(DB_FILE, 'utf-8');
        db = JSON.parse(data);
    } catch (error) {
        // إذا لم يكن الملف موجوداً، قم بإنشائه
        db = {
            transactions: {}, // لتخزين تاريخ شراء كل عملة
            dailySnapshots: [], // لتخزين قيمة المحفظة يومياً
            allTimeProfitLoss: 0 // الربح/الخسارة الإجمالي
        };
        await saveDb();
    }
}

async function saveDb() {
    await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// --- متغيرات الحالة ---
let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolioState = {};
let watchlist = new Set();

// --- دوال OKX API ---
function getHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const bodyString = typeof body === 'object' ? JSON.stringify(body) : body;
  const signString = timestamp + method.toUpperCase() + path + bodyString;
  const signature = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(signString).digest("base64");
  return { "Content-Type": "application/json", "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": signature, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "x-simulated-trading": "0" };
}

async function getMarketPrices() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
    const data = await res.json();
    const prices = {};
    if (data.code === "0" && data.data) {
      data.data.forEach(t => { prices[t.instId] = parseFloat(t.last); });
    }
    return prices;
  } catch (e) { console.error("Error fetching market prices:", e); return {}; }
}

async function getPortfolioData() {
  try {
    const balancePath = "/api/v5/account/balance";
    const res = await fetch(`${API_BASE_URL}${balancePath}`, { headers: getHeaders("GET", balancePath) });
    const data = await res.json();
    if (data.code !== "0") return { assets: null, totalUsd: 0 };

    const prices = await getMarketPrices();
    if (Object.keys(prices).length === 0) return { assets: null, totalUsd: 0 };
    
    const portfolio = [];
    data.data[0].details.forEach(asset => {
      const amount = parseFloat(asset.eq);
      if (amount > 0) {
        const instId = `${asset.ccy}-USDT`;
        const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
        const usdValue = amount * price;
        portfolio.push({ asset: asset.ccy, instId, amount, usdValue, price });
      }
    });

    const totalUsd = portfolio.filter(a => a.usdValue >= 1).reduce((sum, a) => sum + a.usdValue, 0);
    portfolio.forEach(a => { a.percentage = totalUsd > 0 ? ((a.usdValue / totalUsd) * 100) : 0; });
    portfolio.sort((a, b) => b.usdValue - a.usdValue);

    return { assets: portfolio, totalUsd };
  } catch (e) { console.error("Error fetching portfolio:", e); return { assets: null, totalUsd: 0 }; }
}

// --- Middleware ---
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) return;
  await next();
});

// --- عرض الرصيد المطور ---
async function showBalance(ctx) {
  await ctx.reply("⏳ لحظات... جارٍ تحليل أداء المحفظة.");
  const { assets, totalUsd } = await getPortfolioData();
  if (!assets) return ctx.reply("❌ حدث خطأ. يرجى المحاولة مرة أخرى.");

  // حساب التغير اليومي
  const today = new Date().toISOString().split('T')[0];
  const yesterdaySnapshot = db.dailySnapshots.find(s => s.date !== today);
  let dailyChange = 0;
  let dailyChangeSign = "";
  if (yesterdaySnapshot && yesterdaySnapshot.totalUsd > 0) {
      dailyChange = ((totalUsd - yesterdaySnapshot.totalUsd) / yesterdaySnapshot.totalUsd) * 100;
      dailyChangeSign = dailyChange >= 0 ? '📈 +' : '📉 ';
  }

  // حساب الربح الإجمالي
  const allTimeProfitSign = db.allTimeProfitLoss >= 0 ? '💹 +' : '🔻 ';

  let msg = `*📊 ملخص الأداء 📊*\n\n`;
  msg += `*💰 إجمالي القيمة:* *$${totalUsd.toFixed(2)}*\n`;
  msg += `*${dailyChangeSign} التغير اليومي:* *${dailyChange.toFixed(2)}%*\n`;
  msg += `*${allTimeProfitSign} إجمالي الربح/الخسارة:* *$${db.allTimeProfitLoss.toFixed(2)}*\n`;
  msg += `------------------------------------\n`;

  assets.filter(a => a.usdValue >= 1).forEach(a => {
    msg += `*💎 ${a.asset}*\n`;
    if (a.asset !== 'USDT') {
        msg += `   *السعر الحالي:* $${a.price.toFixed(4)}\n`;
    }
    msg += `   *القيمة:* $${a.usdValue.toFixed(2)}  *(${a.percentage.toFixed(2)}%)*\n`;
    msg += `   *الكمية:* ${a.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n\n`;
  });

  const time = new Date().toLocaleTimeString("ar-EG", { hour: '2-digit', minute: '2-digit', hour12: true });
  msg += `_آخر تحديث: ${time}_`;

  ctx.reply(msg, { parse_mode: "Markdown" });
}

// --- دوال المراقبة المطورة ---
async function checkTradesAndCalculatePL(currentAssets, previousAssets, prices) {
    const notifications = [];
    const prevAssetsMap = new Map(previousAssets.filter(a => a.usdValue >= 1).map(a => [a.asset, a]));
    const currentAssetsFiltered = currentAssets.filter(a => a.usdValue >= 1);

    for (const currentAsset of currentAssetsFiltered) {
        const prevAsset = prevAssetsMap.get(currentAsset.asset);
        if (!prevAsset) { // صفقة شراء
            notifications.push(`*🟢 شراء جديد:* ${currentAsset.amount.toFixed(4)} *${currentAsset.asset}* بسعر تقريبي $${currentAsset.price.toFixed(4)}`);
            // تخزين معلومات الشراء
            if (!db.transactions[currentAsset.asset]) db.transactions[currentAsset.asset] = [];
            db.transactions[currentAsset.asset].push({ amount: currentAsset.amount, price: currentAsset.price });
        } else {
            const amountChange = currentAsset.amount - prevAsset.amount;
            if (Math.abs(amountChange) * currentAsset.price > 1) {
                if (amountChange > 0) { // شراء إضافي
                    notifications.push(`*🔵 شراء إضافي:* ${amountChange.toFixed(4)} *${currentAsset.asset}*`);
                    if (!db.transactions[currentAsset.asset]) db.transactions[currentAsset.asset] = [];
                    db.transactions[currentAsset.asset].push({ amount: amountChange, price: currentAsset.price });
                } else { // بيع جزئي أو كلي
                    const soldAmount = Math.abs(amountChange);
                    const salePrice = currentAsset.price;
                    const saleValue = soldAmount * salePrice;
                    
                    // حساب الربح/الخسارة
                    let costBasis = 0;
                    let profitLoss = 0;
                    if (db.transactions[currentAsset.asset] && db.transactions[currentAsset.asset].length > 0) {
                        // استخدام متوسط التكلفة
                        const totalCost = db.transactions[currentAsset.asset].reduce((sum, tx) => sum + (tx.amount * tx.price), 0);
                        const totalAmount = db.transactions[currentAsset.asset].reduce((sum, tx) => sum + tx.amount, 0);
                        const avgCost = totalCost / totalAmount;
                        costBasis = soldAmount * avgCost;
                        profitLoss = saleValue - costBasis;
                        db.allTimeProfitLoss += profitLoss; // تحديث الربح الإجمالي
                        
                        // تحديث سجل الصفقات (بشكل مبسط)
                        db.transactions[currentAsset.asset][0].amount -= soldAmount;
                        if(db.transactions[currentAsset.asset][0].amount <= 0) db.transactions[currentAsset.asset].shift();
                    }
                    
                    const plSign = profitLoss >= 0 ? '💹' : '🔻';
                    const action = currentAsset.amount < 0.1 ? '🔴 بيع كامل' : '🟠 بيع جزئي';
                    notifications.push(`*${action}:* ${soldAmount.toFixed(4)} *${currentAsset.asset}* | *سعر البيع:* $${salePrice.toFixed(4)}\n*${plSign} الربح/الخسارة:* *$${profitLoss.toFixed(2)}*`);
                }
            }
            prevAssetsMap.delete(currentAsset.asset);
        }
    }
    await saveDb();
    return notifications.length > 0 ? `*🔄 حركة الصفقات 🔄*\n\n${notifications.join('\n')}` : null;
}

async function startMonitoring(ctx) {
  if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");
  isMonitoring = true;
  await ctx.reply("✅ تم تفعيل المراقبة الاحترافية. سأقوم بتحليل الصفقات والأداء.");

  const initialState = await getPortfolioData();
  if (!initialState.assets) {
      isMonitoring = false;
      return ctx.reply("❌ فشلت التهيئة.");
  }
  previousPortfolioState = initialState;
  
  // أخذ لقطة يومية للرصيد
  const today = new Date().toISOString().split('T')[0];
  if (!db.dailySnapshots.some(s => s.date === today)) {
      db.dailySnapshots.push({ date: today, totalUsd: initialState.totalUsd });
      // الحفاظ على آخر يومين فقط
      if (db.dailySnapshots.length > 2) db.dailySnapshots.shift();
      await saveDb();
  }

  monitoringInterval = setInterval(async () => {
    const [currentPortfolio, currentPrices] = await Promise.all([getPortfolioData(), getMarketPrices()]);
    if (!currentPortfolio.assets) return;

    const tradeNotifications = await checkTradesAndCalculatePL(currentPortfolio.assets, previousPortfolioState.assets, currentPrices);
    if (tradeNotifications) {
        await bot.api.sendMessage(AUTHORIZED_USER_ID, tradeNotifications, { parse_mode: "Markdown" });
    }

    previousPortfolioState = currentPortfolio;
  }, 45000); // زيادة الفاصل الزمني قليلاً
}

async function stopMonitoring(ctx) {
  if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
  clearInterval(monitoringInterval);
  isMonitoring = false;
  ctx.reply("🛑 تم إيقاف المراقبة.");
}

// --- الأوامر والـ Callbacks ---
const menu = new InlineKeyboard()
  .text("📊 عرض الأداء", "show_balance").row()
  .text("👁️ بدء المراقبة", "start_monitoring")
  .text("🛑 إيقاف المراقبة", "stop_monitoring");
  
const welcomeMessage = `*أهلاً بك في بوت OKX للمحلل الاحترافي* 🤖`;

bot.command("start", ctx => ctx.reply(welcomeMessage, { reply_markup: menu, parse_mode: "Markdown" }));
bot.command("balance", showBalance);
bot.command("monitor", startMonitoring);
bot.command("stop", stopMonitoring);

bot.on("callback_query:data", async ctx => {
  const d = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  if (d === "show_balance") await showBalance(ctx);
  if (d === "start_monitoring") await startMonitoring(ctx);
  if (d === "stop_monitoring") await stopMonitoring(ctx);
});

bot.catch((err) => {
    console.error("--- UNCAUGHT ERROR ---");
    console.error(err.error);
});

// --- التشغيل ---
app.listen(PORT, async () => {
  await initDb(); // تحميل أو إنشاء قاعدة البيانات
  console.log(`Server listening on port ${PORT}`);
  const domain = process.env.RAILWAY_STATIC_URL;
  if (domain) {
    const webhookUrl = `https://${domain}/${bot.token}`;
    try {
      await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
      console.log(`Webhook successfully set to: ${webhookUrl}`);
    } catch (e) { console.error("!!! Failed to set webhook:", e); }
  } else {
    console.error("!!! RAILWAY_STATIC_URL is not set.");
  }
});