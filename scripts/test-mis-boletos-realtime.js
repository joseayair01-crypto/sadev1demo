const { chromium, devices } = require('playwright');

const BASE_URL = 'http://localhost:5001';
const ORDER_ID = 'SS-AA005';
const WHATSAPP = '6764554467';

const targets = [
    {
        name: 'desktop',
        viewport: { width: 1440, height: 1100 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        isMobile: false
    },
    {
        name: 'tablet',
        ...devices['iPad (gen 7) landscape']
    },
    {
        name: 'mobile',
        ...devices['iPhone 13']
    }
];

async function runScenario(target) {
    let browser;
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch (error) {
        browser = await chromium.launch({ headless: true });
    }
    const context = await browser.newContext(target);
    const page = await context.newPage();

    await page.addInitScript(() => {
        window.__socketHandlers = {};
        window.io = () => ({
            on(eventName, handler) {
                window.__socketHandlers[eventName] = handler;
            },
            disconnect() {}
        });
    });

    await page.goto(`${BASE_URL}/mis-boletos.html?ordenId=${encodeURIComponent(ORDER_ID)}`, {
        waitUntil: 'networkidle'
    });

    await page.evaluate((baseUrl) => {
        window.RIFAPLUS_ENV = {
            ...(window.RIFAPLUS_ENV || {}),
            apiBase: baseUrl,
            socketUrl: `${baseUrl}/socket.io/socket.io.js`
        };

        if (window.rifaplusConfig?.backend) {
            window.rifaplusConfig.backend.apiBase = baseUrl;
        }

        if (typeof window.rifaplusConfig?.obtenerApiBase === 'function') {
            window.rifaplusConfig.obtenerApiBase = () => baseUrl;
        }
    }, BASE_URL);

    await page.evaluate((whatsapp) => {
        sessionStorage.setItem('misBoletosWhatsapp', whatsapp);
    }, WHATSAPP);

    await page.fill('#whatsappInput', WHATSAPP);
    await page.click('#btnBuscar');
    await page.waitForSelector('[data-orden-id="SS-AA005"]', { timeout: 15000 });

    await page.evaluate(() => {
        window.__feedbackLog = [];
        const originalShowFeedback = window.rifaplusUtils?.showFeedback?.bind(window.rifaplusUtils);
        if (typeof originalShowFeedback === 'function') {
            window.rifaplusUtils.showFeedback = (message, type) => {
                window.__feedbackLog.push({ message, type });
                return originalShowFeedback(message, type);
            };
        }
    });

    await page.evaluate(() => {
        const handler = window.__socketHandlers?.ordenEstadoActualizadoPublico;
        if (typeof handler !== 'function') {
            throw new Error('No se registró el handler de tiempo real');
        }

        handler({
            orden: {
                numero_orden: 'SS-AA005',
                estado: 'confirmada',
                estado_anterior: 'pendiente',
                updated_at: new Date().toISOString()
            }
        });
    });

    await page.waitForFunction(() => {
        return Array.isArray(window.__feedbackLog)
            && window.__feedbackLog.some((item) => String(item?.message || '').includes('Tu pago fue confirmado'));
    }, { timeout: 10000 });

    const result = await page.evaluate(() => {
        const card = document.querySelector('[data-orden-id="SS-AA005"]');
        const feedback = Array.isArray(window.__feedbackLog) ? window.__feedbackLog[window.__feedbackLog.length - 1] : null;
        return {
            feedback: feedback ? feedback.message : null,
            hasCard: Boolean(card),
            viewportWidth: window.innerWidth
        };
    });

    await browser.close();
    return {
        name: target.name,
        ...result
    };
}

(async () => {
    const results = [];
    for (const target of targets) {
        results.push(await runScenario(target));
    }

    console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
