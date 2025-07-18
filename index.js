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
  "AUTHORIZED_USER_ID"
];
for (const envVar of requiredEnv) {
  if (!process.env[envVar]) {
    console.error(`!!! متغير البيئة ${envVar} غير موجود. قد لا يعمل البوت بشكل صحيح.`);
  }
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || "");
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0", 10);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
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

// --- الدوال الأساسية (بدون تغيير في المنطق) ---
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

        // سنقوم بجلب كل العملات هنا، والفلترة ستتم عند العرض
        portfolio.push({
          asset: asset.ccy,
          instId: instId,
          amount: amount,
          usdValue: usdValue,
          price: price, // **تمت إضافة السعر هنا**
          frozen: parseFloat(asset.frozenBal)
        });
      }
    });

    const totalUsd = portfolio
        .filter(a => a.usdValue >= 1) // حساب الإجمالي فقط للعملات فوق 1 دولار
        .reduce((sum, a) => sum + a.usdValue, 0);

    portfolio.forEach(a => {
      a.percentage = totalUsd > 0 ? ((a.usdValue / totalUsd) * 100) : 0;
    });
    portfolio.sort((a, b) => b.usdValue - a.usdValue);

    return { assets: portfolio, totalUsd };
  } catch (e) {
    console.error("Error fetching portfolio:", e);
    return { assets: null, totalUsd: 0 };
  }
}

// --- Middleware للتحقق من المستخدم ---
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) {
    console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`);
    return;
  }
  await next();
});

// --- دوال الأوامر مع تصميم محسن ---

async function showBalance(ctx) {
  await ctx.reply("⏳ لحظات... جارٍ تحديث بيانات المحفظة.");
  const { assets, totalUsd } = await getPortfolioData();
  if (!assets) return ctx.reply("❌ حدث خطأ أثناء جلب الرصيد. يرجى المحاولة مرة أخرى.");

  let msg = `*📊 ملخص المحفظة 📊*\n\n`;
  msg += `*💰 إجمالي القيمة:* *$${totalUsd.toFixed(2)}*\n`;
  msg += `------------------------------------\n`;

  // **تمت إضافة الفلترة هنا لضمان عدم عرض العملات الصغيرة**
  assets.filter(a => a.usdValue >= 1).forEach(a => {
    msg += `*💎 ${a.asset}*\n`;
    // **تمت إضافة السعر الحالي للعرض**
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

// --- دوال المراقبة مع تصميم محسن للتنبيهات ---

function checkTotalValueChange(currentTotal, previousTotal) {
    if (!previousTotal || previousTotal === 0) return null;
    const changePercent = ((currentTotal - previousTotal) / previousTotal) * 100;
    
    if (Math.abs(changePercent) >= 2) {
        const direction = changePercent > 0 ? '📈 ارتفاع' : '📉 انخفاض';
        return `*🔔 تنبيه إجمالي المحفظة 🔔*\n\n${direction} بنسبة *${Math.abs(changePercent).toFixed(2)}%*\n\n*💰 القيمة الجديدة:* $${currentTotal.toFixed(2)}`;
    }
    return null;
}

function checkAssetCompositionChanges(currentAssets, previousAssets, prices) {
    const changes = [];
    const prevAssetsMap = new Map(previousAssets.filter(a => a.usdValue >=1).map(a => [a.asset, a]));
    const currentAssetsFiltered = currentAssets.filter(a => a.usdValue >=1);

    for (const currentAsset of currentAssetsFiltered) {
        const prevAsset = prevAssetsMap.get(currentAsset.asset);
        if (!prevAsset) {
            changes.push(`*🟢 شراء جديد:* ${currentAsset.amount.toFixed(4)} *${currentAsset.asset}*`);
        } else {
            const amountChange = currentAsset.amount - prevAsset.amount;
            const price = prices[currentAsset.instId] || 0;
            if (Math.abs(amountChange) * price > 1) { 
                const action = amountChange > 0 ? '🔵 شراء إضافي' : '🟠 بيع جزئي';
                changes.push(`*${action}:* ${Math.abs(amountChange).toFixed(4)} *${currentAsset.asset}*`);
            }
            prevAssetsMap.delete(currentAsset.asset);
        }
    }

    for (const soldAsset of prevAssetsMap.values()) {
        changes.push(`*🔴 بيع كامل:* ${soldAsset.amount.toFixed(4)} *${soldAsset.asset}*`);
    }
    
    return changes.length > 0 ? `*🔄 حركة الصفقات 🔄*\n\n${changes.join('\n')}` : null;
}

function checkOwnedAssetPriceChanges(currentAssets, prices) {
    const changes = [];
    for (const asset of currentAssets.filter(a => a.usdValue >= 1)) {
        const currentPrice = prices[asset.instId];
        const previousPrice = monitoredAssetPrices[asset.instId];

        if (currentPrice && previousPrice) {
            const priceChangePercent = ((currentPrice - previousPrice) / previousPrice) * 100;
            if (Math.abs(priceChangePercent) >= 5) {
                 const direction = priceChangePercent > 0 ? '🔼' : '🔽';
                 changes.push(`*${direction} ${asset.asset}:* تغير السعر بنسبة *${priceChangePercent.toFixed(2)}%* ليصل إلى $${currentPrice.toFixed(4)}`);
                 monitoredAssetPrices[asset.instId] = currentPrice;
            }
        }
    }
    return changes.length > 0 ? `*💹 تغيرات أسعار أصولك 💹*\n\n${changes.join('\n')}` : null;
}

function checkWatchlistPriceChanges(prices) {
    const changes = [];
    for (const instId of watchlist) {
        const currentPrice = prices[instId];
        const previousPrice = watchlistPrices[instId];

        if (currentPrice && previousPrice) {
            const priceChangePercent = ((currentPrice - previousPrice) / previousPrice) * 100;
            if (Math.abs(priceChangePercent) >= 5) {
                const direction = priceChangePercent > 0 ? '🔼' : '🔽';
                const assetName = instId.split('-')[0];
                changes.push(`*👁️ ${assetName}:* تغير السعر بنسبة *${priceChangePercent.toFixed(2)}%* ليصل إلى $${currentPrice.toFixed(4)}`);
                watchlistPrices[instId] = currentPrice;
            }
        }
    }
     return changes.length > 0 ? `*📋 تنبيهات قائمة المراقبة 📋*\n\n${changes.join('\n')}` : null;
}


async function startMonitoring(ctx) {
  if (isMonitoring) return ctx.reply("⚠️ المراقبة تعمل بالفعل.");

  isMonitoring = true;
  await ctx.reply("✅ تم تفعيل المراقبة الشاملة. سأقوم بإعلامك بالتغييرات الهامة.");

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

    const compositionChangeMsg = checkAssetCompositionChanges(currentPortfolio.assets, previousPortfolioState.assets, currentPrices);
    if (compositionChangeMsg) allNotifications.push(compositionChangeMsg);

    const ownedPriceChangeMsg = checkOwnedAssetPriceChanges(currentPortfolio.assets, currentPrices);
    if (ownedPriceChangeMsg) allNotifications.push(ownedPriceChangeMsg);
    
    const watchlistChangeMsg = checkWatchlistPriceChanges(currentPrices);
    if (watchlistChangeMsg) allNotifications.push(watchlistChangeMsg);

    if (allNotifications.length > 0) {
        const finalMessage = allNotifications.join("\n\n------------------------------------\n\n");
        try {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, finalMessage, { parse_mode: "Markdown" });
        } catch (e) {
            console.error("Failed to send monitoring update:", e);
        }
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
  ctx.reply("🛑 تم إيقاف المراقبة.");
}

async function addToWatchlist(ctx) {
    const symbol = ctx.match?.toString().toUpperCase();
    if (!symbol) return ctx.reply("*خطأ!* يرجى إدخال رمز العملة.\n*مثال:* `/add BTC`", { parse_mode: "Markdown" });
    
    const instId = `${symbol}-USDT`;
    if (watchlist.has(instId)) {
        return ctx.reply(`*${symbol}* موجودة بالفعل في قائمة المراقبة.`, { parse_mode: "Markdown" });
    }

    const prices = await getMarketPrices();
    if (prices[instId]) {
        watchlist.add(instId);
        if (isMonitoring) {
            watchlistPrices[instId] = prices[instId];
        }
    } else {
        return ctx.reply(`لم أتمكن من العثور على العملة *${symbol}*. تأكد من صحة الرمز.`, { parse_mode: "Markdown" });
    }
    ctx.reply(`✅ تمت إضافة *${symbol}* بنجاح إلى قائمة المراقبة.`, { parse_mode: "Markdown" });
}

async function removeFromWatchlist(ctx) {
    const symbol = ctx.match?.toString().toUpperCase();
    if (!symbol) return ctx.reply("*خطأ!* يرجى إدخال رمز العملة.\n*مثال:* `/remove BTC`", { parse_mode: "Markdown" });
    
    const instId = `${symbol}-USDT`;
    if (!watchlist.has(instId)) {
        return ctx.reply(`*${symbol}* غير موجودة في قائمة المراقبة.`, { parse_mode: "Markdown" });
    }

    watchlist.delete(instId);
    delete watchlistPrices[instId];
    ctx.reply(`🗑️ تمت إزالة *${symbol}* من قائمة المراقبة.`, { parse_mode: "Markdown" });
}

async function viewWatchlist(ctx) {
    if (watchlist.size === 0) {
        return ctx.reply("📋 قائمة المراقبة فارغة حالياً.\n\nاستخدم الأمر `/add <الرمز>` لإضافة عملة (مثال: `/add BTC`).");
    }
    
    const list = Array.from(watchlist).map(id => `• ${id.split('-')[0]}`).join('\n');
    ctx.reply(`*📋 قائمة المراقبة الحالية:*\n${list}`, { parse_mode: "Markdown" });
}

const menu = new InlineKeyboard()
  .text("💰 عرض الرصيد", "show_balance").row()
  .text("👁️ بدء المراقبة", "start_monitoring")
  .text("🛑 إيقاف المراقبة", "stop_monitoring").row()
  .text("📋 عرض قائمة المراقبة", "view_watchlist");
  
const welcomeMessage = `*أهلاً بك في بوت مراقبة OKX* 🤖\n\nاختر أحد الأوامر من القائمة للبدء.`;

bot.command("start", ctx => ctx.reply(welcomeMessage, { reply_markup: menu, parse_mode: "Markdown" }));

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
    console.error("--- UNCAUGHT ERROR ---");
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update?.update_id}:`);
    console.error(err.error);
    console.error("--- END UNCAUGHT ERROR ---");
});

app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  
  const domain = process.env.RAILWAY_STATIC_URL;
  if (domain) {
    const webhookUrl = `https://${domain}/${bot.token}`;
    try {
      await bot.api.setWebhook(webhookUrl, {
        drop_pending_updates: true
      });
      console.log(`Webhook successfully set to: ${webhookUrl}`);
    } catch (e) {
      console.error("!!! Failed to set webhook:", e);
    }
  } else {
    console.error("!!! RAILWAY_STATIC_URL is not set. Webhook will not be configured.");
  }
});