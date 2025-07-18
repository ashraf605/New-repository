// index.js

const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { Pool } = require('pg'); // لاستخدام قاعدة بيانات Postgres
require("dotenv").config();

// --- إعدادات أساسية ---
const requiredEnv = ["TELEGRAM_BOT_TOKEN", "OKX_API_KEY", "OKX_API_SECRET_KEY", "OKX_API_PASSPHRASE", "AUTHORIZED_USER_ID", "DATABASE_URL"];
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) console.error(`!!! متغير البيئة ${envVar} غير موجود.`);
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || "");
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0", 10);
const PORT = process.env.PORT || 3000;

// --- إعداد قاعدة البيانات Postgres ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  const client = await pool.connect();
  try {
    // إنشاء الجداول إذا لم تكن موجودة
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        asset TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        price NUMERIC NOT NULL,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        date DATE PRIMARY KEY,
        total_usd NUMERIC NOT NULL
      );
      CREATE TABLE IF NOT EXISTS internal_state (
        key TEXT PRIMARY KEY,
        value NUMERIC NOT NULL
      );
    `);
    // التأكد من وجود قيمة أولية للربح/الخسارة
    await client.query(`INSERT INTO internal_state (key, value) VALUES ('all_time_profit_loss', 0) ON CONFLICT (key) DO NOTHING;`);
  } finally {
    client.release();
  }
}

// --- دوال OKX API (تبقى كما هي) ---
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
    if (data.code === "0" && data.data) { data.data.forEach(t => { prices[t.instId] = parseFloat(t.last); }); }
    return prices;
  } catch (e) { console.error("Error fetching market prices:", e); return {}; }
}
async function getPortfolioData() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, { headers: getHeaders("GET", "/api/v5/account/balance") });
    const data = await res.json();
    if (data.code !== "0") return { assets: null, totalUsd: 0 };
    const prices = await getMarketPrices();
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
  if (!assets) return ctx.reply("❌ حدث خطأ.");

  const client = await pool.connect();
  try {
    const today = new Date().toISOString().split('T')[0];
    const resYesterday = await client.query("SELECT total_usd FROM snapshots WHERE date != $1 ORDER BY date DESC LIMIT 1", [today]);
    const resProfit = await client.query("SELECT value FROM internal_state WHERE key = 'all_time_profit_loss'");
    
    let dailyChange = 0;
    if (resYesterday.rows.length > 0) {
      const yesterdayTotal = parseFloat(resYesterday.rows[0].total_usd);
      if (yesterdayTotal > 0) dailyChange = ((totalUsd - yesterdayTotal) / yesterdayTotal) * 100;
    }
    const allTimeProfitLoss = resProfit.rows.length > 0 ? parseFloat(resProfit.rows[0].value) : 0;

    const dailyChangeSign = dailyChange >= 0 ? '📈 +' : '📉 ';
    const allTimeProfitSign = allTimeProfitLoss >= 0 ? '💹 +' : '🔻 ';

    let msg = `*📊 ملخص الأداء 📊*\n\n`;
    msg += `*💰 إجمالي القيمة:* *$${totalUsd.toFixed(2)}*\n`;
    msg += `*${dailyChangeSign} التغير اليومي:* *${dailyChange.toFixed(2)}%*\n`;
    msg += `*${allTimeProfitSign} إجمالي الربح/الخسارة:* *$${allTimeProfitLoss.toFixed(2)}*\n`;
    msg += `------------------------------------\n`;

    assets.filter(a => a.usdValue >= 1).forEach(a => {
      msg += `*💎 ${a.asset}*\n`;
      if (a.asset !== 'USDT') msg += `   *السعر الحالي:* $${a.price.toFixed(4)}\n`;
      msg += `   *القيمة:* $${a.usdValue.toFixed(2)}  *(${a.percentage.toFixed(2)}%)*\n`;
      msg += `   *الكمية:* ${a.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n\n`;
    });
    msg += `_آخر تحديث: ${new Date().toLocaleTimeString("ar-EG", { hour: '2-digit', minute: '2-digit', hour12: true })}_`;
    ctx.reply(msg, { parse_mode: "Markdown" });
  } finally {
    client.release();
  }
}

// --- دوال المراقبة المطورة ---
async function checkTradesAndCalculatePL(currentAssets, previousAssets) {
  const notifications = [];
  const prevAssetsMap = new Map(previousAssets.filter(a => a.usdValue >= 1).map(a => [a.asset, a]));
  const currentAssetsFiltered = currentAssets.filter(a => a.usdValue >= 1);
  const client = await pool.connect();

  try {
    for (const currentAsset of currentAssetsFiltered) {
        const prevAsset = prevAssetsMap.get(currentAsset.asset);
        if (!prevAsset) { // صفقة شراء
            notifications.push(`*🟢 شراء جديد:* ${currentAsset.amount.toFixed(4)} *${currentAsset.asset}*`);
            await client.query("INSERT INTO transactions (asset, amount, price) VALUES ($1, $2, $3)", [currentAsset.asset, currentAsset.amount, currentAsset.price]);
        } else {
            const amountChange = currentAsset.amount - prevAsset.amount;
            if (Math.abs(amountChange) * currentAsset.price > 1) { // تجاهل التغييرات الطفيفة
                if (amountChange > 0) { // شراء إضافي
                    notifications.push(`*🔵 شراء إضافي:* ${amountChange.toFixed(4)} *${currentAsset.asset}*`);
                    await client.query("INSERT INTO transactions (asset, amount, price) VALUES ($1, $2, $3)", [currentAsset.asset, amountChange, currentAsset.price]);
                } else { // بيع جزئي أو كلي
                    const soldAmount = Math.abs(amountChange);
                    const salePrice = currentAsset.price;
                    const saleValue = soldAmount * salePrice;
                    
                    const resTxs = await client.query("SELECT amount, price FROM transactions WHERE asset = $1 ORDER BY timestamp ASC", [currentAsset.asset]);
                    let costBasis = 0;
                    let remainingSoldAmount = soldAmount;
                    for (const tx of resTxs.rows) {
                        const txAmount = parseFloat(tx.amount);
                        const txPrice = parseFloat(tx.price);
                        const amountToUse = Math.min(remainingSoldAmount, txAmount);
                        costBasis += amountToUse * txPrice;
                        remainingSoldAmount -= amountToUse;
                        if (remainingSoldAmount <= 0) break;
                    }

                    const profitLoss = saleValue - costBasis;
                    await client.query("UPDATE internal_state SET value = value + $1 WHERE key = 'all_time_profit_loss'", [profitLoss]);
                    
                    const plSign = profitLoss >= 0 ? '💹' : '🔻';
                    const action = currentAsset.amount < 0.1 ? '🔴 بيع كامل' : '🟠 بيع جزئي';
                    notifications.push(`*${action}:* ${soldAmount.toFixed(4)} *${currentAsset.asset}* | *سعر البيع:* $${salePrice.toFixed(4)}\n*${plSign} الربح/الخسارة:* *$${profitLoss.toFixed(2)}*`);
                    
                    // (ملاحظة: حذف سجلات الشراء بعد البيع يتطلب منطقاً أكثر تعقيداً FIFO/LIFO, تم تبسيطه هنا)
                }
            }
            prevAssetsMap.delete(currentAsset.asset);
        }
    }
  } finally {
      client.release();
  }
  return notifications.length > 0 ? `*🔄 حركة الصفقات 🔄*\n\n${notifications.join('\n')}` : null;
}

// ... بقية دوال المراقبة والأوامر تبقى كما هي في المنطق ...
let monitoringInterval = null;
let isMonitoring = false;
let previousPortfolioState = {};

async function startMonitoring(ctx) {
  if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");
  isMonitoring = true;
  await ctx.reply("✅ تم تفعيل المراقبة الاحترافية.");
  
  const initialState = await getPortfolioData();
  if (!initialState.assets) {
      isMonitoring = false;
      return ctx.reply("❌ فشلت التهيئة.");
  }
  previousPortfolioState = initialState;
  
  const client = await pool.connect();
  try {
      const today = new Date().toISOString().split('T')[0];
      await client.query("INSERT INTO snapshots (date, total_usd) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET total_usd = $2", [today, initialState.totalUsd]);
  } finally {
      client.release();
  }

  monitoringInterval = setInterval(async () => {
    const currentPortfolio = await getPortfolioData();
    if (!currentPortfolio.assets) return;

    const tradeNotifications = await checkTradesAndCalculatePL(currentPortfolio.assets, previousPortfolioState.assets);
    if (tradeNotifications) {
        await bot.api.sendMessage(AUTHORIZED_USER_ID, tradeNotifications, { parse_mode: "Markdown" });
    }

    previousPortfolioState = currentPortfolio;
  }, 45000);
}

async function stopMonitoring(ctx) {
  if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
  clearInterval(monitoringInterval);
  isMonitoring = false;
  ctx.reply("🛑 تم إيقاف المراقبة.");
}

const menu = new InlineKeyboard().text("📊 عرض الأداء", "show_balance").row().text("👁️ بدء المراقبة", "start_monitoring").text("🛑 إيقاف المراقبة", "stop_monitoring");
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
bot.catch((err) => console.error("--- UNCAUGHT ERROR ---", err.error));

// --- التشغيل ---
app.listen(PORT, async () => {
  await initDb();
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