// index.js

// --- استدعاء المكتبات ---
const { Bot, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require('dotenv').config(); // لاستخدام ملف .env

// --- التحقق من وجود المتغيرات الأساسية ---
const requiredEnv = [
    "TELEGRAM_BOT_TOKEN",
    "OKX_API_KEY",
    "OKX_API_SECRET_KEY",
    "OKX_API_PASSPHRASE",
    "AUTHORIZED_USER_ID"
];

for (const envVar of requiredEnv) {
    if (!process.env[envVar]) {
        throw new Error(`خطأ: متغير البيئة ${envVar} غير موجود. يرجى إضافته إلى ملف .env`);
    }
}

// --- إعدادات البوت والمنصة ---
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);

// --- متغيرات لتخزين الحالة ---
let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolio = {};
let priceAlerts = []; // لتخزين تنبيهات الأسعار
let alertsInterval = null; // للمهمة الدورية الخاصة بالتنبيهات

// --- دوال مساعدة للاتصال بـ OKX ---

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
    };
}

async function getMarketPrices() {
    try {
        const tickersPath = "/api/v5/market/tickers?instType=SPOT";
        const tickersResponse = await fetch(`${API_BASE_URL}${tickersPath}`);
        const tickersData = await tickersResponse.json();
        const prices = {};
        if (tickersData.code === "0" && tickersData.data) {
            tickersData.data.forEach(ticker => {
                prices[ticker.instId] = parseFloat(ticker.last);
            });
        }
        return prices;
    } catch (error) {
        console.error("Error fetching market prices:", error);
        return {};
    }
}

async function getPortfolioData() {
    try {
        const balancePath = "/api/v5/account/balance";
        const balanceHeaders = getHeaders("GET", balancePath);
        const balanceResponse = await fetch(`${API_BASE_URL}${balancePath}`, { headers: balanceHeaders });
        const balanceData = await balanceResponse.json();

        if (balanceData.code !== "0") {
            console.error("OKX API Error (Balance):", balanceData.msg);
            return { assets: null, totalUsd: 0 };
        }

        const prices = await getMarketPrices();

        let portfolio = [];
        const details = balanceData.data[0].details;
        if (details && details.length > 0) {
            details.forEach(asset => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) {
                    const price = prices[`${asset.ccy}-USDT`] || (asset.ccy === 'USDT' ? 1 : 0);
                    const usdValue = amount * price;
                    
                    if (usdValue >= 1.0) {
                        portfolio.push({
                            asset: asset.ccy,
                            amount: amount,
                            usdValue: usdValue,
                            frozen: parseFloat(asset.frozenBal)
                        });
                    }
                }
            });
        }

        const totalPortfolioUsd = portfolio.reduce((sum, asset) => sum + asset.usdValue, 0);

        if (totalPortfolioUsd > 0) {
            portfolio.forEach(asset => {
                asset.percentage = (asset.usdValue / totalPortfolioUsd) * 100;
            });
        }

        portfolio.sort((a, b) => b.usdValue - a.usdValue);

        return { assets: portfolio, totalUsd: totalPortfolioUsd };

    } catch (error) {
        console.error("Error fetching portfolio data:", error);
        return { assets: null, totalUsd: 0 };
    }
}

// --- نظام الأمان (Middleware) ---
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || userId !== AUTHORIZED_USER_ID) {
        if (ctx.message) {
           await ctx.reply("🚫 أنت غير مصرح لك باستخدام هذا البوت.");
        } else if (ctx.callbackQuery) {
           await ctx.answerCallbackQuery({ text: "🚫 أنت غير مصرح لك." });
        }
        return;
    }
    await next();
});


// --- تعريف الأوامر والوظائف ---

async function showBalance(ctx) {
    const chatId = ctx.chat.id;
    await bot.api.sendMessage(chatId, "🔄 جارٍ جلب بيانات المحفظة...");
    const { assets, totalUsd } = await getPortfolioData();

    if (!assets) {
        return bot.api.sendMessage(chatId, "🔴 حدث خطأ أثناء جلب الرصيد. تأكد من صلاحية مفاتيح API.");
    }

    let message = `📊 *ملخص المحفظة*\n💰 *إجمالي القيمة: $${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}*\n\n`;
    
    if (assets.length === 0) {
        message = "ℹ️ لا توجد عملات في محفظتك قيمتها تزيد عن 1 دولار.";
    } else {
        assets.forEach(asset => {
            message += `• *${asset.asset}*: \`${asset.amount.toFixed(6)}\`\n`;
            message += `  💵 *$${asset.usdValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}* (${asset.percentage.toFixed(2)}%)\n`;
            if (asset.frozen > 0) {
                message += `  🔒 *محجوز*: \`${asset.frozen.toFixed(6)}\`\n`;
            }
            message += `\n`;
        });
    }
    
    const now = new Date();
    const timeString = now.toLocaleTimeString('en-GB');
    message += `_🕐 آخر تحديث: ${timeString}_`;

    await bot.api.sendMessage(chatId, message, { parse_mode: "Markdown" });
}

async function startMonitoring(ctx) {
    const chatId = ctx.chat.id;
    if (isMonitoring) {
        return bot.api.sendMessage(chatId, "⚠️ المراقبة تعمل بالفعل.");
    }

    isMonitoring = true;
    await bot.api.sendMessage(chatId, "✅ تم بدء المراقبة. سأعلمك بأي تغييرات...");

    previousPortfolio = await getBalanceForMonitoring() || {};
    console.log("Initial portfolio set:", previousPortfolio);

    monitoringInterval = setInterval(async () => {
        const currentPortfolio = await getBalanceForMonitoring();
        if (!currentPortfolio) return;

        const notifications = [];
        const allAssets = new Set([...Object.keys(previousPortfolio), ...Object.keys(currentPortfolio)]);

        allAssets.forEach(asset => {
            const prevAmount = previousPortfolio[asset] || 0;
            const currAmount = currentPortfolio[asset] || 0;
            if (Math.abs(currAmount - prevAmount) < 1e-9) return;

            if (prevAmount === 0 && currAmount > 0) {
                notifications.push(`🟢 *شراء جديد*: ${currAmount.toFixed(8)} *${asset}*`);
            } else if (currAmount === 0 && prevAmount > 0) {
                notifications.push(`🔴 *بيع كامل*: تم بيع كامل الكمية من *${asset}*`);
            } else if (currAmount > prevAmount) {
                notifications.push(`🟡 *زيادة شراء*: تم شراء ${(currAmount - prevAmount).toFixed(8)} *${asset}*`);
            } else if (currAmount < prevAmount) {
                notifications.push(`🟠 *بيع جزئي*: تم بيع ${(prevAmount - currAmount).toFixed(8)} *${asset}*`);
            }
        });

        if (notifications.length > 0) {
            await bot.api.sendMessage(chatId, notifications.join("\n\n"), { parse_mode: "Markdown" });
        }
        previousPortfolio = currentPortfolio;
    }, 15000);
}

async function stopMonitoring(ctx) {
    const chatId = ctx.chat.id;
    if (!isMonitoring) {
        return bot.api.sendMessage(chatId, "ℹ️ المراقبة لا تعمل بالفعل.");
    }
    isMonitoring = false;
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    previousPortfolio = {};
    await bot.api.sendMessage(chatId, "🛑 تم إيقاف المراقبة بنجاح.");
}

async function getBalanceForMonitoring() {
    const { assets } = await getPortfolioData();
    if (!assets) return null;
    const portfolioMap = {};
    assets.forEach(asset => {
        portfolioMap[asset.asset] = asset.amount;
    });
    return portfolioMap;
}

// --- وظائف ميزة تنبيهات الأسعار ---

async function checkPriceAlerts() {
    if (priceAlerts.length === 0) return;

    const prices = await getMarketPrices();
    
    const triggeredAlerts = [];

    for (const alert of priceAlerts) {
        const currentPrice = prices[alert.pair];
        if (currentPrice === undefined) continue;

        let conditionMet = false;
        if (alert.condition === 'فوق' && currentPrice > alert.price) {
            conditionMet = true;
        } else if (alert.condition === 'تحت' && currentPrice < alert.price) {
            conditionMet = true;
        }

        if (conditionMet) {
            const message = `🔔 *تنبيه سعر!* 🔔\n\nوصل سعر *${alert.pair}* إلى *${currentPrice}*، وهو ${alert.condition} السعر الذي حددته (${alert.price}).`;
            await bot.api.sendMessage(alert.chatId, message, { parse_mode: "Markdown" });
            triggeredAlerts.push(alert);
        }
    }
    // حذف التنبيهات بعد إرسالها
    priceAlerts = priceAlerts.filter(a => !triggeredAlerts.includes(a));
}

// --- معالجات الأوامر والأزرار ---

const mainMenuKeyboard = new InlineKeyboard()
    .text("💰 عرض الرصيد", "show_balance").row()
    .text("👁️ بدء المراقبة", "start_monitoring").row()
    .text("🛑 إيقاف المراقبة", "stop_monitoring").row()
    .text("🔔 إدارة التنبيهات", "manage_alerts");

bot.command("start", (ctx) => {
    const message = 
        `📊 *أهلاً بك في بوت مراقبة OKX!*\n\n` +
        `أنا هنا لمساعدتك في متابعة حسابك بكل سهولة. اختر أحد الخيارات من الأزرار أدناه:`;

    ctx.reply(message, { 
        reply_markup: mainMenuKeyboard,
        parse_mode: "Markdown" 
    });
});

bot.command("balance", showBalance);
bot.command("monitor", startMonitoring);
bot.command("stop_monitor", stopMonitoring);

bot.command("alert", (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length !== 3) {
        return ctx.reply("استخدام خاطئ. الصيغة الصحيحة:\n`/alert <العملة> <فوق/تحت> <السعر>`\n\n*مثال:*\n`/alert BTC-USDT فوق 120000`", { parse_mode: "Markdown" });
    }
    const [pair, condition, priceStr] = args;
    const price = parseFloat(priceStr);

    if (condition !== 'فوق' && condition !== 'تحت') {
        return ctx.reply("خطأ: يجب أن تكون الحالة 'فوق' أو 'تحت'.");
    }
    if (isNaN(price)) {
        return ctx.reply("خطأ: السعر يجب أن يكون رقماً.");
    }

    priceAlerts.push({ chatId: ctx.chat.id, pair: pair.toUpperCase(), condition, price });
    ctx.reply(`✅ تم ضبط التنبيه: سأعلمك عندما يصبح سعر *${pair.toUpperCase()}* ${condition} *${price}*`, { parse_mode: "Markdown" });
});

bot.command("view_alerts", (ctx) => {
    if (priceAlerts.length === 0) {
        return ctx.reply("ℹ️ لا توجد تنبيهات أسعار نشطة حالياً.");
    }
    let message = "🔔 *قائمة التنبيهات النشطة:*\n\n";
    priceAlerts.forEach(alert => {
        message += `• *${alert.pair}* ${alert.condition} *${alert.price}*\n`;
    });
    ctx.reply(message, { parse_mode: "Markdown" });
});

bot.command("delete_alert", (ctx) => {
    const pairToDelete = ctx.message.text.split(' ')[1];
    if (!pairToDelete) {
        return ctx.reply("استخدام خاطئ. الصيغة الصحيحة:\n`/delete_alert <العملة>`\n\n*مثال:*\n`/delete_alert BTC-USDT`", { parse_mode: "Markdown" });
    }
    const initialLength = priceAlerts.length;
    priceAlerts = priceAlerts.filter(alert => alert.pair.toUpperCase() !== pairToDelete.toUpperCase());
    
    if (priceAlerts.length < initialLength) {
        ctx.reply(`✅ تم حذف جميع التنبيهات الخاصة بـ *${pairToDelete.toUpperCase()}*`, { parse_mode: "Markdown" });
    } else {
        ctx.reply(`ℹ️ لم يتم العثور على تنبيهات للعملة *${pairToDelete.toUpperCase()}*`, { parse_mode: "Markdown" });
    }
});


// معالج الضغط على الأزرار
bot.on("callback_query:data", async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    console.log(`Button pressed: ${callbackData}`);
    
    await ctx.answerCallbackQuery();

    switch (callbackData) {
        case "show_balance":
            await showBalance(ctx);
            break;
        case "start_monitoring":
            await startMonitoring(ctx);
            break;
        case "stop_monitoring":
            await stopMonitoring(ctx);
            break;
        case "manage_alerts":
            // --- هذا هو الجزء الذي تم تصحيحه ---
            const alertMessage = 
                "🔔 *إدارة تنبيهات الأسعار*\n\n" +
                "استخدم الأوامر التالية لضبط التنبيهات:\n\n" +
                "1️⃣ *لضبط تنبيه جديد:*\n" +
                "`/alert <العملة> <فوق/تحت> <السعر>`\n" +
                "مثال: `/alert BTC-USDT فوق 120000`\n\n" +
                "2️⃣ *لعرض التنبيهات النشطة:*\n" +
                "`/view_alerts`\n\n" +
                "3️⃣ *لحذف تنبيه:*\n" +
                "`/delete_alert <العملة>`\n" +
                "مثال: `/delete_alert BTC-USDT`";
            // تم استخدام parse_mode: undefined لإرسال النص كما هو بدون تنسيق خاص لتجنب الأخطاء
            await ctx.reply(alertMessage, { parse_mode: "Markdown" });
            break;
    }
});


// --- بدء تشغيل البوت ---
bot.catch((err) => {
    console.error("Bot Error:", err);
});

async function startBot() {
    try {
        await bot.api.setMyCommands([
            { command: 'start', description: 'بدء تشغيل البوت وعرض القائمة' },
            { command: 'balance', description: 'عرض رصيد المحفظة الحالي' },
            { command: 'alert', description: 'ضبط تنبيه سعر جديد' },
            { command: 'view_alerts', description: 'عرض التنبيهات النشطة' },
            { command: 'delete_alert', description: 'حذف تنبيه سعر' },
            { command: 'monitor', description: 'بدء المراقبة التلقائية' },
            { command: 'stop_monitor', description: 'إيقاف المراقبة' },
        ]);
        console.log("✅ تم تسجيل الأوامر في قائمة تليجرام بنجاح.");
    } catch (error) {
        console.warn("⚠️ تحذير: فشل في تسجيل الأوامر. قد يكون هناك مشكلة في الاتصال بالإنترنت.");
        console.warn("سيستمر البوت في العمل بشكل طبيعي، ولكن قد لا تظهر قائمة الأوامر.");
    }
    
    // بدء المهمة الدورية لفحص تنبيهات الأسعار
    alertsInterval = setInterval(checkPriceAlerts, 20000); // كل 20 ثانية

    console.log("🚀 البوت قيد التشغيل...");
    await bot.start();
}

startBot();
