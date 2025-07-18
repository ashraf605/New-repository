// index.js

const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

// --- التحقق من متغيرات البيئة ---
const requiredEnv = [
  "TELEGRAM_BOT_TOKEN",
  "OKX_API_KEY",
  "OKX_API_SECRET_KEY",
  "OKX_API_PASSPHRASE",
  "AUTHORIZED_USER_ID",
  "RAILWAY_STATIC_URL" // متغير جديد ومهم جداً
];
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    // لا تقم بإيقاف التطبيق بالكامل، فقط سجل الخطأ
    console.error(`!!! متغير البيئة ${envVar} غير موجود. قد لا يعمل البوت بشكل صحيح.`);
  }
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || "");
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0", 10);
const PORT = process.env.PORT || 3000;

// --- إعدادات Express ---
const app = express();
app.use(express.json()); // مهم جداً للـ webhooks

// --- إعداد Webhook ---
// هذا هو المسار الذي سيستقبل التحديثات من تلغرام
app.use(`/${bot.token}`, webhookCallback(bot, "express"));

app.get("/", (req, res) => {
  res.send("OKX Bot is running with Webhooks!");
});

// --- متغيرات الحالة للمراقبة ---
let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolioState = {};
let monitoredAssetPrices = {};
let watchlist = new Set();
let watchlistPrices = {};

// ... (جميع دوال البوت الأخرى تبقى كما هي بدون تغيير) ...
// getHeaders, getMarketPrices, getPortfolioData, showBalance, 
// checkTotalValueChange, checkAssetCompositionChanges, etc.

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
    "x-simulated-trading": "0"
  };
}

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

        if (usdValue >= 1) {
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

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) {
    return ctx.reply("🚫 غير مصرح لك باستخدام هذا البوت.");
  }
  await next();
});

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

function checkTotalValueChange(currentTotal, previousTotal) {
    if (!previousTotal || previousTotal === 0) return null;
    const changePercent = ((currentTotal - previousTotal) / previousTotal) * 100;
    
    if (Math.abs(changePercent) >= 2) {
        const direction = changePercent > 0 ? 'ارتفاع' : 'انخفاض';
        return `🔔 *تنبيه القيمة الإجمالية*: ${direction} بنسبة ${Math.abs(changePercent).toFixed(2)}%\n💰 *الإجمالي الجديد*: $${currentTotal.toFixed(2)}`;
    }
    return null;
}

function checkAssetCompositionChanges(currentAssets, previousAssets) {
    const changes = [];
    const prevAssetsMap = new Map(previousAssets.map(a => [a.asset, a]));

    for (const currentAsset of currentAssets) {
        const prevAsset = prevAssetsMap.get(currentAsset.asset);
        if (!prevAsset) {
            changes.push(`🟢 *شراء جديد*: ${currentAsset.amount.toFixed(4)} ${currentAsset.asset}`);
        } else {
            if (currentAsset.amount.toFixed(8) !== prevAsset.amount.toFixed(8)) {
                const diff = currentAsset.amount - prevAsset.amount;
                const action = diff > 0 ? 'شراء' : 'بيع';
                changes.push(`*تغيير في* ${currentAsset.asset}: ${action} ${Math.abs(diff).toFixed(4)}`);
            }
            prevAssetsMap.delete(currentAsset.asset);
        }
    }

    for (const soldAsset of prevAssetsMap.values()) {
        changes.push(`🔴 *بيع كامل*: ${soldAsset.amount.toFixed(4)} ${soldAsset.asset}`);
    }
    
    return changes.length > 0 ? `🔄 *تغيرات في الأصول*:\n- ${changes.join('\n- ')}` : null;
}

function checkOwnedAssetPriceChanges(currentAssets, prices) {
    const changes = [];
    for (const asset of currentAssets) {
        const currentPrice = prices[asset.instId];
        const previousPrice = monitoredAssetPrices[asset.instId];

        if (currentPrice && previousPrice) {
            const priceChangePercent = ((currentPrice - previousPrice) / previousPrice) * 100;
            if (Math.abs(priceChangePercent) >= 5) {
                 const direction = priceChangePercent > 0 ? 'ارتفاع' : 'انخفاض';
                 changes.push(`📈 *${asset.asset}*: ${direction} بنسبة ${Math.abs(priceChangePercent).toFixed(2)}% إلى $${currentPrice.toFixed(4)}`);
                 monitoredAssetPrices[asset.instId] = currentPrice;
            }
        }
    }
    return changes.length > 0 ? `💹 *تغيرات أسعار أصولك*:\n- ${changes.join('\n- ')}` : null;
}

function checkWatchlistPriceChanges(prices) {
    const changes = [];
    for (const instId of watchlist) {
        const currentPrice = prices[instId];
        const previousPrice = watchlistPrices[instId];

        if (currentPrice && previousPrice) {
            const priceChangePercent = ((currentPrice - previousPrice) / previousPrice) * 100;
            if (Math.abs(priceChangePercent) >= 5) {
                const direction = priceChangePercent > 0 ? 'ارتفاع' : 'انخفاض';
                const assetName = instId.split('-')[0];
                changes.push(`👁️ *${assetName}*: ${direction} بنسبة ${Math.abs(priceChangePercent).toFixed(2)}% إلى $${currentPrice.toFixed(4)}`);
                watchlistPrices[instId] = currentPrice;
            }
        }
    }
     return changes.length > 0 ? `📋 *تنبيهات قائمة المراقبة*:\n- ${changes.join('\n- ')}` : null;
}


async function startMonitoring(ctx) {
  if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");

  isMonitoring = true;
  await ctx.reply("✅ بدأت المراقبة. سأقوم بإعلامك بالتغييرات الهامة...");

  const initialState = await getPortfolioData();
  const initialPrices = await getMarketPrices();
  
  if (!initialState.assets || !initialPrices) {
      isMonitoring = false;
      return ctx.reply("❌ فشلت التهيئة، لا يمكن بدء المراقبة.");
  }

  previousPortfolioState = initialState;
  
  monitoredAssetPrices = {};
  initialState.assets.forEach(asset => {
      monitoredAssetPrices[asset.instId] = initialPrices[asset.instId];
  });
  
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
    const totalValueChangeMsg = checkTotalValueChange(currentPortfolio.totalUsd, previousPortfolioState.totalUsd);
    if (totalValueChangeMsg) allNotifications.push(totalValueChangeMsg);

    const compositionChangeMsg = checkAssetCompositionChanges(currentPortfolio.assets, previousPortfolioState.assets);
    if (compositionChangeMsg) allNotifications.push(compositionChangeMsg);

    const ownedPriceChangeMsg = checkOwnedAssetPriceChanges(currentPortfolio.assets, currentPrices);
    if (ownedPriceChangeMsg) allNotifications.push(ownedPriceChangeMsg);
    
    const watchlistChangeMsg = checkWatchlistPriceChanges(currentPrices);
    if (watchlistChangeMsg) allNotifications.push(watchlistChangeMsg);

    if (allNotifications.length > 0) {
        const finalMessage = allNotifications.join("\n\n");
        // نستخدم bot.api.sendMessage لإرسال الرسائل خارج سياق الطلب
        await bot.api.sendMessage(AUTHORIZED_USER_ID, finalMessage, { parse_mode: "Markdown" });
    }

    previousPortfolioState = currentPortfolio;
    currentPortfolio.assets.forEach(asset => {
        if (!monitoredAssetPrices[asset.instId]) {
            monitoredAssetPrices[asset.instId] = currentPrices[asset.instId];
        }
    });

  }, 30000);
}

async function stopMonitoring(ctx) {
  if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
  clearInterval(monitoringInterval);
  isMonitoring = false;
  ctx.reply("🛑 توقفت المراقبة.");
}

async function addToWatchlist(ctx) {
    const symbol = ctx.match?.toString().toUpperCase();
    if (!symbol) return ctx.reply("يرجى إدخال رمز العملة بعد الأمر، مثال: `/add BTC`");
    
    const instId = `${symbol}-USDT`;
    if (watchlist.has(instId)) {
        return ctx.reply(`*${symbol}* موجودة بالفعل في القائمة.`, { parse_mode: "Markdown" });
    }

    watchlist.add(instId);
    if (isMonitoring) {
        const prices = await getMarketPrices();
        if (prices[instId]) {
            watchlistPrices[instId] = prices[instId];
        }
    }
    ctx.reply(`✅ تمت إضافة *${symbol}* إلى قائمة المراقبة.`, { parse_mode: "Markdown" });
}

async function removeFromWatchlist(ctx) {
    const symbol = ctx.match?.toString().toUpperCase();
    if (!symbol) return ctx.reply("يرجى إدخال رمز العملة بعد الأمر، مثال: `/remove BTC`");
    
    const instId = `${symbol}-USDT`;
    if (!watchlist.has(instId)) {
        return ctx.reply(`*${symbol}* غير موجودة في القائمة.`, { parse_mode: "Markdown" });
    }

    watchlist.delete(instId);
    delete watchlistPrices[instId];
    ctx.reply(`🗑️ تمت إزالة *${symbol}* من قائمة المراقبة.`, { parse_mode: "Markdown" });
}

async function viewWatchlist(ctx) {
    if (watchlist.size === 0) {
        return ctx.reply("قائمة المراقبة فارغة حالياً.");
    }
    
    const list = Array.from(watchlist).map(id => `• ${id.split('-')[0]}`).join('\n');
    ctx.reply(`📋 *قائمة المراقبة الحالية*:\n${list}`, { parse_mode: "Markdown" });
}

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
bot.command("stop", stopMonitoring);
bot.command("stop_monitor", stopMonitoring);
bot.command("add", addToWatchlist);
bot.command("add_watchlist", addToWatchlist);
bot.command("remove", removeFromWatchlist);
bot.command("remove_watchlist", removeFromWatchlist);
bot.command("watchlist", viewWatchlist);
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
    const e = err.error;
    if (e instanceof Error) {
        console.error(e);
    }
});

// --- تشغيل الخادم والـ Webhook ---
// لا تستخدم bot.start() بعد الآن
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  // نقوم بتسجيل الـ webhook مع تلغرام عند بدء التشغيل
  const webhookUrl = `https://${process.env.RAILWAY_STATIC_URL}/${bot.token}`;
  await bot.api.setWebhook(webhookUrl);
  console.log(`Webhook set to: ${webhookUrl}`);
});