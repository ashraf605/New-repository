// index.js

const express = require("express");
const { Bot, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("OKX Bot is running");
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// التحقق من وجود جميع متغيرات البيئة المطلوبة
const requiredEnv = [
  "TELEGRAM_BOT_TOKEN",
  "OKX_API_KEY",
  "OKX_API_SECRET_KEY",
  "OKX_API_PASSPHRASE",
  "AUTHORIZED_USER_ID"
];
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    throw new Error(`متغير البيئة ${envVar} غير موجود. يرجى إضافته.`);
  }
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);

// --- متغيرات الحالة للمراقبة ---
let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolioState = {}; // لتخزين حالة المحفظة السابقة (الإجمالي، الأصول)
let monitoredAssetPrices = {}; // لتخزين أسعار أصول المحفظة للمقارنة
let watchlist = new Set(); // قائمة المراقبة الحرة (باستخدام Set لمنع التكرار)
let watchlistPrices = {}; // لتخزين أسعار عملات قائمة المراقبة

/**
 * إنشاء الترويسات اللازمة لطلبات OKX API
 * @param {string} method - GET, POST, etc.
 * @param {string} path - The request path, e.g., /api/v5/account/balance
 * @param {string|object} body - The request body for POST requests
 * @returns {object} - The headers object
 */
function getHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const bodyString = typeof body === 'object' ? JSON.stringify(body) : body;
  const signString = timestamp + method.toUpperCase() + path + bodyString;
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
    "x-simulated-trading": "0" // 0 للتداول الحقيقي
  };
}

/**
 * جلب أسعار السوق الحالية لجميع العملات (SPOT)
 * @returns {Promise<object>} - An object mapping instrument ID to its last price
 */
async function getMarketPrices() {
  try {
    const tickersPath = "/api/v5/market/tickers?instType=SPOT";
    const res = await fetch(`${API_BASE_URL}${tickersPath}`);
    const data = await res.json();
    const prices = {};
    if (data.code === "0" && data.data) {
      data.data.forEach(t => {
        prices[t.instId] = parseFloat(t.last);
      });
    }
    return prices;
  } catch (e) {
    console.error("Error fetching market prices:", e);
    return {};
  }
}

/**
 * جلب بيانات المحفظة الكاملة
 * @returns {Promise<object>} - An object containing portfolio assets and total USD value
 */
async function getPortfolioData() {
  try {
    const balancePath = "/api/v5/account/balance";
    const headers = getHeaders("GET", balancePath);
    const res = await fetch(`${API_BASE_URL}${balancePath}`, { headers });
    const data = await res.json();

    if (data.code !== "0") {
        console.error("Error fetching portfolio data from OKX:", data.msg);
        return { assets: null, totalUsd: 0 };
    }

    const prices = await getMarketPrices();
    if (Object.keys(prices).length === 0) {
        return { assets: null, totalUsd: 0 };
    }
    
    const portfolio = [];
    data.data[0].details.forEach(asset => {
      const amount = parseFloat(asset.eq);
      if (amount > 0) {
        const instId = `${asset.ccy}-USDT`;
        const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
        const usdValue = amount * price;

        if (usdValue >= 1) { // تجاهل الأصول ذات القيمة المنخفضة جداً
          portfolio.push({
            asset: asset.ccy,
            instId: instId,
            amount: amount,
            usdValue: usdValue,
            frozen: parseFloat(asset.frozenBal)
          });
        }
      }
    });

    const totalUsd = portfolio.reduce((sum, a) => sum + a.usdValue, 0);
    portfolio.forEach(a => {
      a.percentage = totalUsd > 0 ? ((a.usdValue / totalUsd) * 100).toFixed(2) : "0.00";
    });
    portfolio.sort((a, b) => b.usdValue - a.usdValue);

    return { assets: portfolio, totalUsd };
  } catch (e) {
    console.error("Error fetching portfolio:", e);
    return { assets: null, totalUsd: 0 };
  }
}

// Middleware للتحقق من هوية المستخدم
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) {
    return ctx.reply("🚫 غير مصرح لك باستخدام هذا البوت.");
  }
  await next();
});

// --- دوال الأوامر الأساسية ---

async function showBalance(ctx) {
  await ctx.reply("⏳ جارٍ جلب بيانات المحفظة...");
  const { assets, totalUsd } = await getPortfolioData();
  if (!assets) return ctx.reply("❌ خطأ في جلب الرصيد. يرجى التحقق من سجلات الخادم.");

  let msg = `📊 *ملخص المحفظة*\n💰 *الإجمالي:* $${totalUsd.toFixed(2)}\n\n`;
  assets.forEach(a => {
    msg += `• *${a.asset}*: $${a.usdValue.toFixed(2)} (${a.percentage}%)\n   *الكمية:* ${a.amount.toFixed(6)}\n`;
  });

  const time = new Date().toLocaleString("ar-EG");
  msg += `\n_آخر تحديث: ${time}_`;

  ctx.reply(msg, { parse_mode: "Markdown" });
}

// --- دوال المراقبة المحسّنة ---

/**
 * (المتطلب #3) رصد التغير في القيمة الإجمالية للمحفظة
 */
function checkTotalValueChange(currentTotal, previousTotal) {
    if (!previousTotal || previousTotal === 0) return null;
    const changePercent = ((currentTotal - previousTotal) / previousTotal) * 100;
    
    if (Math.abs(changePercent) >= 2) { // حساسية 2%
        const direction = changePercent > 0 ? 'ارتفاع' : 'انخفاض';
        return `🔔 *تنبيه القيمة الإجمالية*: ${direction} بنسبة ${Math.abs(changePercent).toFixed(2)}%\n💰 *الإجمالي الجديد*: $${currentTotal.toFixed(2)}`;
    }
    return null;
}

/**
 * (المتطلب #1) رصد عمليات البيع والشراء (تغير كميات الأصول)
 */
function checkAssetCompositionChanges(currentAssets, previousAssets) {
    const changes = [];
    const prevAssetsMap = new Map(previousAssets.map(a => [a.asset, a]));

    for (const currentAsset of currentAssets) {
        const prevAsset = prevAssetsMap.get(currentAsset.asset);
        if (!prevAsset) {
            changes.push(`🟢 *شراء جديد*: ${currentAsset.amount.toFixed(4)} ${currentAsset.asset}`);
        } else {
            // مقارنة الكميات بدقة لكشف البيع أو الشراء الجزئي
            if (currentAsset.amount.toFixed(8) !== prevAsset.amount.toFixed(8)) {
                const diff = currentAsset.amount - prevAsset.amount;
                const action = diff > 0 ? 'شراء' : 'بيع';
                changes.push(`*تغيير في* ${currentAsset.asset}: ${action} ${Math.abs(diff).toFixed(4)}`);
            }
            prevAssetsMap.delete(currentAsset.asset);
        }
    }

    // الأصول المتبقية في الخريطة تم بيعها بالكامل
    for (const soldAsset of prevAssetsMap.values()) {
        changes.push(`🔴 *بيع كامل*: ${soldAsset.amount.toFixed(4)} ${soldAsset.asset}`);
    }
    
    return changes.length > 0 ? `🔄 *تغيرات في الأصول*:\n- ${changes.join('\n- ')}` : null;
}

/**
 * (المتطلب #2) رصد تغير أسعار أصول المحفظة
 */
function checkOwnedAssetPriceChanges(currentAssets, prices) {
    const changes = [];
    for (const asset of currentAssets) {
        const currentPrice = prices[asset.instId];
        const previousPrice = monitoredAssetPrices[asset.instId];

        if (currentPrice && previousPrice) {
            const priceChangePercent = ((currentPrice - previousPrice) / previousPrice) * 100;
            if (Math.abs(priceChangePercent) >= 5) { // حساسية 5%
                 const direction = priceChangePercent > 0 ? 'ارتفاع' : 'انخفاض';
                 changes.push(`📈 *${asset.asset}*: ${direction} بنسبة ${Math.abs(priceChangePercent).toFixed(2)}% إلى $${currentPrice.toFixed(4)}`);
                 monitoredAssetPrices[asset.instId] = currentPrice; // تحديث السعر بعد التنبيه
            }
        }
    }
    return changes.length > 0 ? `💹 *تغيرات أسعار أصولك*:\n- ${changes.join('\n- ')}` : null;
}

/**
 * (المتطلب #4) رصد تغير أسعار قائمة المراقبة الحرة
 */
function checkWatchlistPriceChanges(prices) {
    const changes = [];
    for (const instId of watchlist) {
        const currentPrice = prices[instId];
        const previousPrice = watchlistPrices[instId];

        if (currentPrice && previousPrice) {
            const priceChangePercent = ((currentPrice - previousPrice) / previousPrice) * 100;
            if (Math.abs(priceChangePercent) >= 5) { // حساسية 5%
                const direction = priceChangePercent > 0 ? 'ارتفاع' : 'انخفاض';
                const assetName = instId.split('-')[0];
                changes.push(`👁️ *${assetName}*: ${direction} بنسبة ${Math.abs(priceChangePercent).toFixed(2)}% إلى $${currentPrice.toFixed(4)}`);
                watchlistPrices[instId] = currentPrice; // تحديث السعر
            }
        }
    }
     return changes.length > 0 ? `📋 *تنبيهات قائمة المراقبة*:\n- ${changes.join('\n- ')}` : null;
}


async function startMonitoring(ctx) {
  if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");

  isMonitoring = true;
  await ctx.reply("✅ بدأت المراقبة. سأقوم بإعلامك بالتغييرات الهامة...");

  // التهيئة الأولية للحالة
  const initialState = await getPortfolioData();
  const initialPrices = await getMarketPrices();
  
  if (!initialState.assets || !initialPrices) {
      isMonitoring = false;
      return ctx.reply("❌ فشلت التهيئة، لا يمكن بدء المراقبة.");
  }

  previousPortfolioState = initialState;
  
  // تهيئة أسعار الأصول المملوكة
  monitoredAssetPrices = {};
  initialState.assets.forEach(asset => {
      monitoredAssetPrices[asset.instId] = initialPrices[asset.instId];
  });
  
  // تهيئة أسعار قائمة المراقبة
  watchlistPrices = {};
  for (const instId of watchlist) {
      watchlistPrices[instId] = initialPrices[instId];
  }

  monitoringInterval = setInterval(async () => {
    const [currentPortfolio, currentPrices] = await Promise.all([getPortfolioData(), getMarketPrices()]);
    
    if (!currentPortfolio.assets || Object.keys(currentPrices).length === 0) {
        console.log("Skipping monitoring cycle due to data fetch error.");
        return;
    }

    const allNotifications = [];

    // 1. فحص تغير القيمة الإجمالية
    const totalValueChangeMsg = checkTotalValueChange(currentPortfolio.totalUsd, previousPortfolioState.totalUsd);
    if (totalValueChangeMsg) allNotifications.push(totalValueChangeMsg);

    // 2. فحص تغيرات الأصول (بيع/شراء)
    const compositionChangeMsg = checkAssetCompositionChanges(currentPortfolio.assets, previousPortfolioState.assets);
    if (compositionChangeMsg) allNotifications.push(compositionChangeMsg);

    // 3. فحص تغيرات أسعار الأصول المملوكة
    const ownedPriceChangeMsg = checkOwnedAssetPriceChanges(currentPortfolio.assets, currentPrices);
    if (ownedPriceChangeMsg) allNotifications.push(ownedPriceChangeMsg);
    
    // 4. فحص تغيرات أسعار قائمة المراقبة
    const watchlistChangeMsg = checkWatchlistPriceChanges(currentPrices);
    if (watchlistChangeMsg) allNotifications.push(watchlistChangeMsg);

    // إرسال التنبيهات إذا وجدت
    if (allNotifications.length > 0) {
        const finalMessage = allNotifications.join("\n\n");
        ctx.reply(finalMessage, { parse_mode: "Markdown" });
    }

    // تحديث الحالة للدورة التالية
    previousPortfolioState = currentPortfolio;
    // تحديث أسعار الأصول المملوكة التي لم يتم التنبيه عنها
    currentPortfolio.assets.forEach(asset => {
        if (!monitoredAssetPrices[asset.instId]) {
            monitoredAssetPrices[asset.instId] = currentPrices[asset.instId];
        }
    });

  }, 30000); // زيادة الفاصل الزمني إلى 30 ثانية لتقليل الحمل على API
}

async function stopMonitoring(ctx) {
  if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
  clearInterval(monitoringInterval);
  isMonitoring = false;
  ctx.reply("🛑 توقفت المراقبة.");
}

// --- دوال قائمة المراقبة ---
async function addToWatchlist(ctx) {
    const symbol = ctx.match?.toUpperCase();
    if (!symbol) return ctx.reply("يرجى إدخال رمز العملة بعد الأمر، مثال: `/add_watchlist BTC`");
    
    const instId = `${symbol}-USDT`;
    if (watchlist.has(instId)) {
        return ctx.reply(`*${symbol}* موجودة بالفعل في القائمة.`, { parse_mode: "Markdown" });
    }

    watchlist.add(instId);
    // إذا كانت المراقبة تعمل، قم بجلب السعر الحالي مباشرة
    if (isMonitoring) {
        const prices = await getMarketPrices();
        if (prices[instId]) {
            watchlistPrices[instId] = prices[instId];
        }
    }
    ctx.reply(`✅ تمت إضافة *${symbol}* إلى قائمة المراقبة.`, { parse_mode: "Markdown" });
}

async function removeFromWatchlist(ctx) {
    const symbol = ctx.match?.toUpperCase();
    if (!symbol) return ctx.reply("يرجى إدخال رمز العملة بعد الأمر، مثال: `/remove_watchlist BTC`");
    
    const instId = `${symbol}-USDT`;
    if (!watchlist.has(instId)) {
        return ctx.reply(`*${symbol}* غير موجودة في القائمة.`, { parse_mode: "Markdown" });
    }

    watchlist.delete(instId);
    delete watchlistPrices[instId]; // حذف السعر من الذاكرة
    ctx.reply(`🗑️ تمت إزالة *${symbol}* من قائمة المراقبة.`, { parse_mode: "Markdown" });
}

async function viewWatchlist(ctx) {
    if (watchlist.size === 0) {
        return ctx.reply("قائمة المراقبة فارغة حالياً.");
    }
    
    const list = Array.from(watchlist).map(id => `• ${id.split('-')[0]}`).join('\n');
    ctx.reply(`📋 *قائمة المراقبة الحالية*:\n${list}`, { parse_mode: "Markdown" });
}


// --- لوحة المفاتيح والأوامر ---

const menu = new InlineKeyboard()
  .text("💰 عرض الرصيد", "show_balance").row()
  .text("👁️ بدء المراقبة", "start_monitoring")
  .text("🛑 إيقاف المراقبة", "stop_monitoring").row()
  .text("📋 عرض قائمة المراقبة", "view_watchlist");

bot.command("start", ctx =>
  ctx.reply("أهلاً بك في بوت مراقبة OKX المحسّن! اختر أحد الأوامر:", { reply_markup: menu })
);

bot.command("balance", showBalance);
bot.command("monitor", startMonitoring);
bot.command("stop", stopMonitoring); // أمر مختصر
bot.command("stop_monitor", stopMonitoring);
bot.command("add", addToWatchlist); // أمر مختصر
bot.command("add_watchlist", addToWatchlist);
bot.command("remove", removeFromWatchlist); // أمر مختصر
bot.command("remove_watchlist", removeFromWatchlist);
bot.command("watchlist", viewWatchlist); // أمر مختصر
bot.command("view_watchlist", viewWatchlist);


bot.on("callback_query:data", async ctx => {
  const d = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  if (d === "show_balance") await showBalance(ctx);
  if (d === "start_monitoring") await startMonitoring(ctx);
  if (d === "stop_monitoring") await stopMonitoring(ctx);
  if (d === "view_watchlist") await viewWatchlist(ctx);
});

bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    console.error(err.error);
});

bot.start();

