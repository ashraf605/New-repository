// index.js (النسخة الكاملة والمُصححة)

const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

// --- إعداد السيرفر ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("OKX Bot is running"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- التحقق من متغيرات البيئة ---
const requiredEnv = [
  "TELEGRAM_BOT_TOKEN",
  "OKX_API_KEY",
  "OKX_API_SECRET_KEY",
  "OKX_API_PASSPHRASE",
  "AUTHORIZED_USER_ID"
];
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    throw new Error(`متغير البيئة ${envVar} غير موجود. يرجى إضافته في Railway`);
  }
}

// --- إعدادات البوت والـ API ---
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);

// --- إدارة حالة البوت ---
let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolio = {};
let assetChangeThreshold = 2; // قيمة افتراضية يمكنك تغييرها
let totalChangeThreshold = 5; // قيمة افتراضية يمكنك تغييرها

// --- وظائف الـ API ---
function getHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const signString = timestamp + method.toUpperCase() + path + (body ? JSON.stringify(body) : "");
  const signature = crypto
    .createHmac("sha256", process.env.OKX_API_SECRET_KEY)
    .update(signString)
    .digest("base64");
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": process.env.OKX_API_KEY,
    "OK-ACCESS-SIGN": signature,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
    "x-simulated-trading": "0" 
  };
}

async function getMarketPrices(currencies) {
  if (currencies.length === 0) return {};
  try {
    const instIds = currencies.map(c => `${c}-USDT`).join(',');
    const tickersPath = `/api/v5/market/tickers?instType=SPOT&instId=${instIds}`;
    const res = await fetch(`${API_BASE_URL}${tickersPath}`);
    const data = await res.json();
    const prices = {};
    if (data.code === "0" && data.data) {
      data.data.forEach(t => prices[t.instId] = parseFloat(t.last));
    }
    return prices;
  } catch (e) {
    console.error("Error fetching market prices:", e);
    return { error: e.message };
  }
}

async function getPortfolioData() {
  try {
    const balancePath = "/api/v5/account/balance";
    const headers = getHeaders("GET", balancePath);
    const res = await fetch(`${API_BASE_URL}${balancePath}`, { headers });
    const data = await res.json();
    if (data.code !== "0") return { assets: null, totalUsd: 0, error: data.msg || `OKX API Error: ${data.code}` };
    
    const ownedCurrencies = data.data[0].details
      .filter(asset => parseFloat(asset.eq) > 0 && asset.ccy !== 'USDT')
      .map(asset => asset.ccy);

    const prices = await getMarketPrices(ownedCurrencies);
    if (prices.error) return { assets: null, totalUsd: 0, error: `Failed to fetch prices: ${prices.error}` };

    const portfolio = [];
    data.data[0].details.forEach(asset => {
      const amount = parseFloat(asset.eq);
      if (amount > 0.000001) { 
        const price = prices[`${asset.ccy}-USDT`] || (asset.ccy === "USDT" ? 1 : 0);
        const usdValue = amount * price;
        if (usdValue >= 1) portfolio.push({ asset: asset.ccy, amount, usdValue, frozen: parseFloat(asset.frozenBal) });
      }
    });

    const totalUsd = portfolio.reduce((sum, a) => sum + a.usdValue, 0);
    if (totalUsd > 0) portfolio.forEach(a => a.percentage = ((a.usdValue / totalUsd) * 100).toFixed(2));
    portfolio.sort((a, b) => b.usdValue - a.usdValue);
    return { assets: portfolio, totalUsd, error: null };
  } catch (e) {
    console.error("Error fetching portfolio:", e);
    return { assets: null, totalUsd: 0, error: e.message };
  }
}

// --- وسيط التحقق من المستخدم ---
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) {
    return ctx.reply("🚫 غير مصرح لك باستخدام هذا البوت.");
  }
  await next();
});

// --- وظائف البوت الأساسية ---
async function showBalance(ctx) {
  await ctx.reply("⏳ جارٍ جلب بيانات المحفظة...");
  const { assets, totalUsd, error } = await getPortfolioData();
  if (error) return ctx.reply(`❌ خطأ: ${error}`);
  if (!assets || assets.length === 0) return ctx.reply("ℹ️ محفظتك فارغة.");
  let msg = `📊 *ملخص المحفظة*\n💰 *الإجمالي:* $${totalUsd.toFixed(2)}\n\n`;
  assets.forEach(a => msg += `• *${a.asset}*: $${a.usdValue.toFixed(2)} (${a.percentage}%)\n`);
  const time = new Date().toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo" });
  msg += `\n_آخر تحديث: ${time}_`;
  ctx.reply(msg, { parse_mode: "Markdown" });
}

async function checkPortfolioAndNotify(ctx) {
    const currentPortfolio = await getPortfolioData();
    if (currentPortfolio.error) return ctx.reply(`⚠️ فشلت المراقبة: ${currentPortfolio.error}`);
    if (!currentPortfolio.assets || !previousPortfolio.assets) {
        previousPortfolio = currentPortfolio;
        return;
    }
    const changes = [];
    const totalChangePercentage = previousPortfolio.totalUsd > 0 ? Math.abs(((currentPortfolio.totalUsd - previousPortfolio.totalUsd) / previousPortfolio.totalUsd) * 100) : 0;
    currentPortfolio.assets.forEach(curr => {
        const prev = previousPortfolio.assets.find(a => a.asset === curr.asset);
        if (!prev) changes.push(`🟢 *شراء جديد:* ${curr.asset} (${curr.percentage}%)`);
        else {
            const percentageChange = Math.abs(parseFloat(curr.percentage) - parseFloat(prev.percentage));
            if (percentageChange >= assetChangeThreshold) {
                const dir = curr.percentage > prev.percentage ? '📈' : '📉';
                changes.push(`${dir} *${curr.asset}*: ${curr.percentage}% (كان ${prev.percentage}%)`);
            }
        }
    });
    previousPortfolio.assets.forEach(prev => {
        if (!currentPortfolio.assets.find(a => a.asset === prev.asset)) changes.push(`🔴 *بيع كامل:* ${prev.asset}`);
    });
    if (changes.length > 0 || totalChangePercentage >= totalChangeThreshold) {
        let msg = `🔔 *تنبيه بتغيرات المحفظة*\n💰 *الإجمالي:* $${currentPortfolio.totalUsd.toFixed(2)}\n\n` + changes.join("\n");
        ctx.reply(msg, { parse_mode: "Markdown" });
    }
    previousPortfolio = currentPortfolio;
}

async function startMonitoring(ctx) {
  if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");
  isMonitoring = true;
  await ctx.reply(`✅ بدأت المراقبة.\n- تنبيه الأصل: *${assetChangeThreshold}%*\n- تنبيه الإجمالي: *${totalChangeThreshold}%*`, { parse_mode: "Markdown" });
  previousPortfolio = await getPortfolioData();
  if (previousPortfolio.error) {
      isMonitoring = false;
      return ctx.reply(`❌ فشل بدء المراقبة: ${previousPortfolio.error}`);
  }
  monitoringInterval = setInterval(() => checkPortfolioAndNotify(ctx), 15000);
}

async function stopMonitoring(ctx) {
  if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
  clearInterval(monitoringInterval);
  isMonitoring = false;
  ctx.reply("🛑 توقفت المراقبة.");
}

// --- إعداد الأوامر والقائمة ---
const menu = new InlineKeyboard()
  .text("💰 عرض الرصيد", "show_balance").row()
  .text("👁️ بدء المراقبة", "start_monitoring").row()
  .text("🛑 إيقاف المراقبة", "stop_monitoring");

bot.command("start", ctx =>
  ctx.reply("أهلاً بك! استخدم القائمة أو الأوامر مباشرة.\n`/balance`\n`/set_thresholds 2 5`", { reply_markup: menu })
);

// **[تصحيح]** إعادة أمر /balance المباشر
bot.command("balance", showBalance);

bot.command("set_thresholds", async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    const newAssetThresh = parseFloat(args[0]);
    const newTotalThresh = parseFloat(args[1]);
    if (isNaN(newAssetThresh) || isNaN(newTotalThresh) || newAssetThresh <= 0 || newTotalThresh <= 0) {
        return ctx.reply("❌ صيغة خاطئة. مثال:\n`/set_thresholds 2 5`");
    }
    assetChangeThreshold = newAssetThresh;
    totalChangeThreshold = newTotalThresh;
    await ctx.reply(`✅ تم تحديث العتبات:\n- تنبيه الأصل: *${assetChangeThreshold}%*\n- تنبيه الإجمالي: *${totalChangeThreshold}%*`, { parse_mode: "Markdown" });
});

// **[تصحيح]** استعادة منطق معالجة ضغطات الأزرار
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery(); // مهم لإزالة علامة التحميل من الزر
  switch (data) {
    case "show_balance":
      await showBalance(ctx);
      break;
    case "start_monitoring":
      await startMonitoring(ctx);
      break;
    case "stop_monitoring":
      await stopMonitoring(ctx);
      break;
  }
});

// --- بدء تشغيل البوت ---
bot.catch((err) => console.error("Error in bot:", err));
bot.start();
console.log("Bot started successfully!");
