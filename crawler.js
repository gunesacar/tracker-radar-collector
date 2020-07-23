const fs = require('fs');
const USE_EVASION = true;
// const puppeteer = require('puppeteer');
const puppeteer = require('puppeteer-extra');
// tested on https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html

if (USE_EVASION) {
    // add stealth plugin and use defaults (all evasion techniques)
    const StealthPlugin = require('puppeteer-extra-plugin-stealth')
    puppeteer.use(StealthPlugin())
}else{
    //const puppeteer = require('puppeteer');
}

const chalk = require('chalk').default;
const {createTimer} = require('./helpers/timer');
const wait = require('./helpers/wait');
const tldts = require('tldts');

const MAX_LOAD_TIME = 30000;//ms
// const MAX_TOTAL_TIME = MAX_LOAD_TIME * 2;//ms
const MAX_TOTAL_TIME = MAX_LOAD_TIME * 3;//ms
const EXECUTION_WAIT_TIME = 10000;//ms

// const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/77.0.3865.90 Safari/537.36';
// updated for CNAME measurement
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.97 Safari/537.36'

const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; Pixel 2 XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.117 Mobile Safari/537.36';

const DEFAULT_VIEWPORT = {
    width: 1440,//px
    height: 812//px
};
const MOBILE_VIEWPORT = {
    width: 412,
    height: 691,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
};

// for debugging: will lunch in window mode instad of headless, open devtools and don't close windows after process finishes
const VISUAL_DEBUG = false;

async function openBrowser() {

    const browser = await puppeteer.launch(VISUAL_DEBUG ? {
        headless: false,
        devtools: true,
        // for debugging: use different version of Chromium/Chrome
        // executablePath: "/Applications/Google\ Chrome\ Canary.app/Contents/MacOS/Google\ Chrome\ Canary"
    } : {});

    return browser;
}

/**
 * @param {puppeteer.Browser} browser
 */
async function closeBrowser(browser) {
    if (!VISUAL_DEBUG) {
        await browser.close();
    }
}


/**
 * @param {puppeteer.Page} page
 *
 * @returns {Promise<Array>}
 */
async function collectSriValues(page) {
    let script_sris = await page.evaluate(() => {
        let links = document.getElementsByTagName('script');
        // return Array.from(links);
        return Array.from(links).filter(script=>script.src).map(x => [x.src, x.integrity]);
    });
    return script_sris;
}

/**
 * @param {Array<Object>} targets
 */

async function stopLoadingTargets(targets){
    for (let target of targets) {
        if (target.type === 'page') {
            // eslint-disable-next-line no-await-in-loop
            await target.cdpClient.send('Page.stopLoading');
        }
    }
}


/**
 * @param {puppeteer.Browser} browser
 * @param {URL} url
 * @param {{collectors: import('./collectors/BaseCollector')[], log: function(...any):void, rank?: number, urlFilter: function(string, string):boolean, emulateMobile: boolean}} data
 *
 * @returns {Promise<CollectResult>}
 */
async function getSiteData(browser, url, {
    collectors,
    log,
    rank,
    urlFilter,
    emulateMobile
}) {
    const testStarted = Date.now();

    // Create a new incognito browser context.
    const context = await browser.createIncognitoBrowserContext();
    /**
     * @type {{cdpClient: import('puppeteer').CDPSession, type: string, url: string}[]}
     */
    const targets = [];

    const collectorOptions = {
        browser,
        context,
        url,
        log
    };

    for (let collector of collectors) {
        const timer = createTimer();

        try {
            // eslint-disable-next-line no-await-in-loop
            await collector.init(collectorOptions);
            log(`${collector.id()} init took ${timer.getElapsedTime()}s`);
        } catch (e) {
            log(chalk.yellow(`${collector.id()} init failed`), chalk.gray(e.message), chalk.gray(e.stack));
        }
    }

    // initiate collectors for all contexts (main page, web worker, service worker etc.)
    context.on('targetcreated', async target => {
        const timer = createTimer();
        const cdpClient = await target.createCDPSession();
        const simpleTarget = {url: target.url(), type: target.type(), cdpClient};
        targets.push(simpleTarget);

        // we have to pause new targets and attach to them as soon as they are created not to miss any data
        await cdpClient.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: true});

        for (let collector of collectors) {
            try {
                // eslint-disable-next-line no-await-in-loop
                await collector.addTarget(simpleTarget);
            } catch (e) {
                log(chalk.yellow(`${collector.id()} failed to attach to "${target.url()}"`), chalk.gray(e.message), chalk.gray(e.stack));
            }
        }

        try {
            // resume target when all collectors are ready
            await cdpClient.send('Runtime.enable');
            await cdpClient.send('Runtime.runIfWaitingForDebugger');
        } catch (e) {
            log(chalk.yellow(`Failed to resume target "${target.url()}"`), chalk.gray(e.message), chalk.gray(e.stack));
            return;
        }

        log(`${target.url()} context initiated in ${timer.getElapsedTime()}s`);
    });

    // Create a new page in a pristine context.
    const page = await context.newPage();


    await page.emulate({
        // just in case some sites block headless visits
        userAgent: emulateMobile ? MOBILE_USER_AGENT : DEFAULT_USER_AGENT,
        viewport: emulateMobile ? MOBILE_VIEWPORT : DEFAULT_VIEWPORT
    });

    // if any prompts open on page load, they'll make the page hang unless closed
    page.on('dialog', dialog => dialog.dismiss());

    // catch and report crash errors
    page.on('error', e => log(chalk.red(e.message)));

    let timeout = false;

    try {
        await page.goto(url.toString(), {timeout: MAX_LOAD_TIME, waitUntil: 'networkidle0'});
    } catch (e) {
        if (e && e.message && e.message.startsWith('Navigation Timeout Exceeded')) {
            log(chalk.yellow('Navigation timeout exceeded.'));
            await stopLoadingTargets(targets);
            /*
            for (let target of targets) {
                if (target.type === 'page') {
                    // eslint-disable-next-line no-await-in-loop
                    await target.cdpClient.send('Page.stopLoading');
                }
            }
            */
            timeout = true;
        } else {
            throw e;
        }
    }

    // give website a bit more time for things to settle
    await page.waitFor(EXECUTION_WAIT_TIME);

    const finalUrl = page.url();
    const RELOAD_PAGE_FOR_CNAME_MEASUREMENT = true;

    if (RELOAD_PAGE_FOR_CNAME_MEASUREMENT){

        try {
            await page.reload({timeout: MAX_LOAD_TIME, waitUntil: ["networkidle0", "domcontentloaded"] });
            // await page.reload({timeout: 0.01, waitUntil: ["networkidle0", "domcontentloaded"] });
        } catch (e) {
            if (e && e.message && e.message.startsWith('Navigation Timeout Exceeded')) {
                log(chalk.yellow('Navigation timeout exceeded during reload.'));
                await stopLoadingTargets(targets);
                timeout = true;
            } else {
                throw e;
            }
        }

        await page.waitFor(EXECUTION_WAIT_TIME);
    }
    await page.screenshot({path: 'screenshots/' + url.hostname + '.png'})

    let sri_values = [];
    // get JS SRI values on the top level document
    sri_values.push([url, await collectSriValues(page)])

    /**
     * @param {puppeteer.Page|puppeteer.Frame} pageOrFrame
     */
    async function extractFrameContents(pageOrFrame) {
        const frames = await pageOrFrame.$$('iframe');
        for (let frameElement of frames) {
            const frame = await frameElement.contentFrame();
            log("Will search the frame for links", frame.url())
            let script_details = await collectSriValues(frame);

            if (script_details.length){
                sri_values.push([frame.url(), script_details])
            }
            // recursively repeat
            await extractFrameContents(frame);
        }
    }

    await extractFrameContents(page);

    fs.writeFileSync(`sri/${url.hostname}.json`, JSON.stringify(sri_values, null, 2));

    let bodyHTML = await page.content();
    fs.writeFileSync(`html/${url.hostname}.html`, bodyHTML);

    /**
     * @type {Object<string, Object>}
     */
    const data = {};

    for (let collector of collectors) {
        const timer = createTimer();
        try {
            // eslint-disable-next-line no-await-in-loop
            const collectorData = await collector.getData({
                finalUrl,
                urlFilter: urlFilter && urlFilter.bind(null, finalUrl)
            });
            data[collector.id()] = collectorData;
            log(`getting ${collector.id()} data took ${timer.getElapsedTime()}s`);
        } catch (e) {
            log(chalk.yellow(`getting ${collector.id()} data failed`), chalk.gray(e.message), chalk.gray(e.stack));
            data[collector.id()] = null;
        }
    }

    for (let target of targets) {
        // eslint-disable-next-line no-await-in-loop
        try {
            await target.cdpClient.detach();
        } catch (e) {
            log(chalk.yellow(`detaching from ${target.url} failed`), chalk.gray(e.message));
        }
    }

    if (!VISUAL_DEBUG) {
        await page.close();
        await context.close();
    }

    return {
        initialUrl: url.toString(),
        finalUrl,
        rank,
        timeout,
        testStarted,
        testFinished: Date.now(),
        data
    };
}

/**
 * @param {string} documentUrl
 * @param {string} requestUrl
 * @returns {boolean}
 */
function isThirdPartyRequest(documentUrl, requestUrl) {
    const mainPageDomain = tldts.getDomain(documentUrl);

    return tldts.getDomain(requestUrl) !== mainPageDomain;
}

/**
 * @param {URL} url
 * @param {{collectors?: import('./collectors/BaseCollector')[], log?: function(...any):void, rank?: number, filterOutFirstParty?: boolean, emulateMobile: boolean}} options
 * @returns {Promise<CollectResult>}
 */
module.exports = async (url, options) => {
    const browser = await openBrowser();
    let data = null;

    try {
        data = await wait(getSiteData(browser, url, {
            collectors: options.collectors || [],
            log: options.log || (() => {}),
            rank: options.rank,
            urlFilter: options.filterOutFirstParty === true ? isThirdPartyRequest.bind(null) : null,
            emulateMobile: options.emulateMobile
        }), MAX_TOTAL_TIME);
    } catch(e) {
        options.log(chalk.red('Crawl failed'), e.message, chalk.gray(e.stack));
        throw e;
    } finally {
        await closeBrowser(browser);
    }

    return data;
};

/**
 * @typedef {Object} CollectResult
 * @property {string} initialUrl URL from which the crawler began the crawl (as provided by the caller)
 * @property {string} finalUrl URL after page has loaded (can be different from initialUrl if e.g. there was a redirect)
 * @property {number?} rank website's rank (as provided by the caller)
 * @property {boolean} timeout true if page didn't fully load before the timeout and loading had to be stopped by the crawler
 * @property {number} testStarted time when the crawl started (unix timestamp)
 * @property {number} testFinished time when the crawl finished (unix timestamp)
 * @property {object} data object containing output from all collectors
*/
