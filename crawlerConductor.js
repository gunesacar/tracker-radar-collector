const os = require('os');
const cores = os.cpus().length;
const chalk = require('chalk').default;
const async = require('async');
const crawl = require('./crawler');
const URL = require('url').URL;
const {createTimer} = require('./helpers/timer');
const createDeferred = require('./helpers/deferred');
// eslint-disable-next-line no-unused-vars
const BaseCollector = require('./collectors/BaseCollector');

const MAX_NUMBER_OF_CRAWLERS = 38;// by trial and error there seems to be network bandwidth issues with more than 38 browsers. 
const MAX_NUMBER_OF_RETRIES = 2;

/**
 * @param {string} urlString 
 * @param {BaseCollector[]} dataCollectors
 * @param {number} idx 
 * @param {function} log 
 * @param {boolean} filterOutFirstParty
 * @param {function(URL, object): void} dataCallback 
 * @param {boolean} emulateMobile
 * @param {string} proxyHost
 */
async function crawlAndSaveData(urlString, dataCollectors, idx, log, filterOutFirstParty, dataCallback, emulateMobile, proxyHost) {
    const url = new URL(urlString);
    /**
     * @type {function(...any):void} 
     */
    const prefixedLog = (...msg) => log(chalk.gray(`${url.hostname}:`), ...msg);

    const data = await crawl(url, {
        log: prefixedLog,
        // @ts-ignore
        collectors: dataCollectors.map(collector => new collector.constructor()),
        rank: idx + 1,
        filterOutFirstParty,
        emulateMobile,
        proxyHost
    });

    dataCallback(url, data);
}

/**
 * @param {{urls: string[], dataCallback: function(URL, object): void, dataCollectors?: BaseCollector[], failureCallback?: function(string, Error): void, numberOfCrawlers?: number, logFunction?: function, filterOutFirstParty: boolean, emulateMobile: boolean, proxyHost: string}} options
 */
module.exports = options => {
    const deferred = createDeferred();
    const log = options.logFunction || (() => {});
    const failureCallback = options.failureCallback || (() => {});

    let numberOfCrawlers = options.numberOfCrawlers || Math.floor(cores * 0.8);
    numberOfCrawlers = Math.min(MAX_NUMBER_OF_CRAWLERS, numberOfCrawlers, options.urls.length);

    // Increase number of listeners so we have at least one listener for each async process
    if (numberOfCrawlers > process.getMaxListeners()) {
        process.setMaxListeners(numberOfCrawlers + 1);
    }
    log(chalk.cyan(`Number of crawlers: ${numberOfCrawlers}\n`));

    async.eachOfLimit(options.urls, numberOfCrawlers, (urlString, idx, callback) => {
        log(chalk.cyan(`Processing entry #${Number(idx) + 1} (${urlString}).`));
        const timer = createTimer();

        const task = crawlAndSaveData.bind(null, urlString, options.dataCollectors, idx, log, options.filterOutFirstParty, options.dataCallback, options.emulateMobile, options.proxyHost);

        async.retry(MAX_NUMBER_OF_RETRIES, task, err => {
            if (err) {
                log(chalk.red(`Max number of retries (${MAX_NUMBER_OF_RETRIES}) exceeded for "${urlString}".`));
                failureCallback(urlString, err);
            } else {
                log(chalk.cyan(`Processing "${urlString}" took ${timer.getElapsedTime()}s.`));
            }

            callback();
        });
    }, err => {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve();
        }
    });

    return deferred.promise;
};