/* eslint-disable max-lines */
const {getAllInitiators} = require('../helpers/initiators');
const {filterHeaders, normalizeHeaders} = require('../helpers/headers');
const BaseCollector = require('./BaseCollector');

const URL = require('url').URL;
const crypto = require('crypto');
const {Buffer} = require('buffer');

const DEFAULT_SAVE_HEADERS = ['etag', 'set-cookie', 'cache-control', 'expires', 'pragma', 'p3p', 'timing-allow-origin', 'access-control-allow-origin'];

class RequestCollector extends BaseCollector {

    /**
     * @param {{saveResponseHash?: boolean, saveHeaders?: Array<string>}} additionalOptions
     */
    constructor(additionalOptions = {saveResponseHash: false, saveHeaders: DEFAULT_SAVE_HEADERS}) {
        super();
        this._saveResponseHash = (additionalOptions.saveResponseHash === true);
        this._saveHeaders = DEFAULT_SAVE_HEADERS;

        if (additionalOptions.saveHeaders) {
            this._saveHeaders = additionalOptions.saveHeaders.map(h => h.toLocaleLowerCase());
        }
    }

    id() {
        return 'requests';
    }

    /**
     * @param {import('./BaseCollector').CollectorInitOptions} options
     */
    init({
        log,
    }) {
        /**
         * @type {InternalRequestData[]}
         */
        this._requests = [];
        this._log = log;
        this._unmatched_extra_resp_info = new Map();
        this._unmatched_extra_req_info = new Map();
    }

    /**
     * @param {{cdpClient: import('puppeteer').CDPSession, url: string, type: import('puppeteer').TargetType}} targetInfo
     */
    async addTarget({cdpClient}) {
        await cdpClient.send('Runtime.enable');
        await cdpClient.send('Runtime.setAsyncCallStackDepth', {maxDepth: 32});

        await cdpClient.send('Network.enable');

        await Promise.all([
            cdpClient.on('Network.requestWillBeSent', r => this.handleRequest(r, cdpClient)),
            cdpClient.on('Network.requestWillBeSentExtraInfo', r => this.handleRequestWillBeSentExtraInfo(r)),
            cdpClient.on('Network.webSocketCreated', r => this.handleWebSocket(r)),
            cdpClient.on('Network.responseReceived', r => this.handleResponse(r)),
            cdpClient.on('Network.responseReceivedExtraInfo', r => this.handleResponseExtraInfo(r)),
            cdpClient.on('Network.loadingFailed', r => this.handleFailedRequest(r, cdpClient)),
            cdpClient.on('Network.loadingFinished', r => this.handleFinishedRequest(r, cdpClient))
        ]);
    }

    /**
     * @param {RequestId} id
     */
    findLastRequestWithId(id) {
        let i = this._requests.length;

        while (i--) {
            if (this._requests[i].id === id) {
                return this._requests[i];
            }
        }

        return null;
    }

    /**
     * @param {RequestId} id
     * @param {import('puppeteer').CDPSession} cdp
     */
    async getResponseBodyHash(id, cdp) {
        try {
            // @ts-ignore oversimplified .send signature
            let {body, base64Encoded} = await cdp.send('Network.getResponseBody', {requestId: id});

            if (base64Encoded) {
                body = Buffer.from(body, 'base64');
            }

            return crypto.createHash('sha256').update(body).digest('hex');
        } catch (e) {
            return null;
        }
    }

    /**
     * @param {{initiator: object, request: CDPRequest, requestId: RequestId, timestamp: Timestamp, frameId?: FrameId, type?: ResourceType, redirectResponse?: CDPResponse}} data
     * @param {import('puppeteer').CDPSession} cdp
     */
    handleRequest(data, cdp) {
        const {
            requestId: id,
            type,
            request,
            redirectResponse,
            timestamp: startTime
        } = data;

        let initiator = data.initiator;
        const url = request.url;
        const method = request.method;
        let postData;

        this._log("REQ", url, id);

        let headers = this._unmatched_extra_req_info.get(id);
        /*
        if (headers){
            this._log(Object.keys(headers).length, Object.keys(request.headers).length)
            // this._log(response.url, "extrainfo_headers", typeof(headers), headers)
            // this._log(response.url, "response.headers", typeof(response.headers), response.headers)
        }
        */

        // request.responseHeaders = normalizeHeaders(headers ? headers: response.headers);
        let requestHeaders = normalizeHeaders(headers ? headers: request.headers);

        // for CORS requests initiator is set incorrectly to 'parser', thankfully we can get proper initiator
        // from the corresponding OPTIONS request
        if (method !== 'OPTIONS' && initiator.type === 'parser') {
            for (let i = this._requests.length - 1; i >= 0; i--) {
                const oldRequest = this._requests[i];

                if (oldRequest.method === 'OPTIONS' && oldRequest.url === url) {
                    initiator = oldRequest.initiator;
                    break;
                }
            }
        } else if (method === "POST") {
            postData = request.postData;
        }

        /**
         * @type {InternalRequestData}
         */
        const requestData = {id, url, method, type, initiator, startTime, postData, requestHeaders};

        // if request A gets redirected to B which gets redirected to C chrome will produce 4 events:
        // requestWillBeSent(A) requestWillBeSent(B) requestWillBeSent(C) responseReceived()
        // responseReceived doesn't fire for each redirect, so we can't use it to save response for each redirect
        // thankfully response data for request A are available in requestWillBeSent(B) event, request B response is in requestWillBeSent(C), etc.
        // we can also easily match those requests togheter because they all have same requestId
        // so what we do here is copy those responses to corresponding requests
        if (redirectResponse) {
            const previousRequest = this.findLastRequestWithId(id);

            if (previousRequest) {
                this.handleResponse({
                    requestId: id,
                    type,
                    response: redirectResponse
                });
                this.handleFinishedRequest({
                    requestId: id,
                    timestamp: startTime
                }, cdp);

                // initiators of redirects are useless (they point to the main document), copy initiator from original request
                requestData.initiator = previousRequest.initiator;

                // we store both: where request was redirected from and where it redirects to
                previousRequest.redirectedTo = url;
                requestData.redirectedFrom = previousRequest.url;
            }
        }

        this._requests.push(requestData);
    }

    /**
     * @param {{requestId: RequestId, url: string, initiator: object}} request
     */
    handleWebSocket(request) {
        this._requests.push({
            id: request.requestId,
            url: request.url,
            type: 'WebSocket',
            initiator: request.initiator
        });
    }

    /**
     * @param {{requestId: RequestId, type: ResourceType, frameId?: FrameId, response: CDPResponse}} data
     */
    handleResponse(data) {
        const {
            requestId: id,
            type,
            response
        } = data;
        const request = this.findLastRequestWithId(id);
        // this._log('RECEIVED response', id, response.url);

        if (!request) {
            this._log('⚠️ unmatched response', id, response.url);
            return;
        }
        this._log("RESP", request.url, id);

        request.type = type || request.type;
        request.status = response.status;
        request.remoteIPAddress = response.remoteIPAddress;
        // prioritize raw headers received via handleResponseExtraInfo as response.headers available here
        // might be filtered (e.g. missing set-cookie header)
        if (!request.responseHeaders) {
            // check if we received an handleResponseExtraInfo for this request
            let headers = this._unmatched_extra_resp_info.get(id);

            if (headers) {
                this._log("Extra", Object.keys(headers).length, "response", Object.keys(response.headers).length)
                // this._log(response.url, "extrainfo_headers", typeof(headers), headers)
                // this._log(response.url, "response.headers", typeof(response.headers), response.headers)
            }

            request.responseHeaders = normalizeHeaders(headers ? headers: response.headers);
        }
    }

    /**
     * Network.responseReceivedExtraInfo
     * @param {{requestId: RequestId, headers: object}} data
     */
    handleResponseExtraInfo(data) {
        const {
            requestId: id,
            headers
        } = data;
        const request = this.findLastRequestWithId(id);
        if (!request) {
            // this._log('⚠️ unmatched extra info', id, headers);
            this._log('⚠️ unmatched extra info', id);
            this._unmatched_extra_resp_info.set(id, headers);
            return;
        }

        request.responseHeaders = normalizeHeaders(headers);
    }

    /**
     * Network.requestWillBeSentExtraInfo
     * @param {{requestId: RequestId, associatedCookies: object, headers: object}} data
     */
    handleRequestWillBeSentExtraInfo(data) {
        const {
            requestId: id,
            associatedCookies,
            headers
        } = data;
        const request = this.findLastRequestWithId(id);
        if (!request) {
            // this._log('⚠️ unmatched extra REQ info', id, headers);
            // this._log('⚠️ unmatched extra REQ, info', id, headers);
            this._unmatched_extra_req_info.set(id, headers)
            return;
        }
        // this._log("associatedCookies", associatedCookies)

        request.requestHeaders = normalizeHeaders(headers);
    }


    /**
     * @param {{errorText: string, requestId: RequestId, timestamp: Timestamp, type: ResourceType}} data
     * @param {import('puppeteer').CDPSession} cdp
     */
    async handleFailedRequest(data, cdp) {
        const request = this.findLastRequestWithId(data.requestId);

        if (!request) {
            this._log('⚠️ unmatched failed response', data);
            return;
        }

        request.endTime = data.timestamp;
        request.failureReason = data.errorText || 'unknown error';

        if (this._saveResponseHash) {
            request.responseBodyHash = await this.getResponseBodyHash(data.requestId, cdp);
        }
    }

    /**
     * @param {{requestId: RequestId, encodedDataLength?: number, timestamp: Timestamp}} data
     * @param {import('puppeteer').CDPSession} cdp
     */
    async handleFinishedRequest(data, cdp) {
        const request = this.findLastRequestWithId(data.requestId);

        if (!request) {
            this._log('⚠️ unmatched finished response', data);
            return;
        }

        request.endTime = data.timestamp;
        request.size = data.encodedDataLength;

        if (this._saveResponseHash) {
            request.responseBodyHash = await this.getResponseBodyHash(data.requestId, cdp);
        }
    }

    /**
     * @param {{finalUrl: string, urlFilter?: function(string):boolean}} options
     * @returns {RequestData[]}
     */
    getData({urlFilter}) {
        return this._requests
            .filter(request => {
                let url;

                try {
                    url = new URL(request.url);
                } catch (e) {
                    // ignore requests with invalid URL
                    return false;
                }

                if (url.protocol === 'data:') {
                    return false;
                }

                return urlFilter ? urlFilter(request.url) : true;
            })
            .map(request => ({
                url: request.url,
                method: request.method,
                type: request.type,
                status: request.status,
                size: request.size,
                remoteIPAddress: request.remoteIPAddress,
                responseHeaders: request.responseHeaders && filterHeaders(request.responseHeaders, this._saveHeaders),
                requestHeaders: request.requestHeaders,
                responseBodyHash: request.responseBodyHash,
                failureReason: request.failureReason,
                redirectedTo: request.redirectedTo,
                redirectedFrom: request.redirectedFrom,
                initiators: Array.from(getAllInitiators(request.initiator)),
                time: (request.startTime && request.endTime) ? (request.endTime - request.startTime) : undefined,
                postData: request.postData
            }));
    }
}

module.exports = RequestCollector;

/**
 * @typedef RequestData
 * @property {string} url
 * @property {import('puppeteer').HttpMethod} method
 * @property {ResourceType} type
 * @property {string[]=} initiator
 * @property {string=} redirectedFrom
 * @property {string=} redirectedTo
 * @property {number=} status
 * @property {string} remoteIPAddress
 * @property {object} requestHeaders
 * @property {object} responseHeaders
 * @property {string=} responseBodyHash
 * @property {string} failureReason
 * @property {number=} size in bytes
 * @property {number=} time in seconds
 */

/**
 * @typedef InternalRequestData
 * @property {RequestId} id
 * @property {string} url
 * @property {import('puppeteer').HttpMethod=} method
 * @property {ResourceType} type
 * @property {object=} initiator
 * @property {string=} redirectedFrom
 * @property {string=} redirectedTo
 * @property {number=} status
 * @property {string=} remoteIPAddress
 * @property {Object<string,string>=} responseHeaders
 * @property {Object<string,string>=} requestHeaders
 * @property {string=} failureReason
 * @property {number=} size
 * @property {Timestamp=} startTime
 * @property {Timestamp=} endTime
 * @property {string=} responseBodyHash
 * @property {string=} postData
 */

/**
 * @typedef {string} RequestId
 */

/**
 * @typedef {number} Timestamp
 */

/**
 * @typedef {'Document'|'Stylesheet'|'Image'|'Media'|'Font'|'Script'|'TextTrack'|'XHR'|'Fetch'|'EventSource'|'WebSocket'|'Manifest'|'SignedExchange'|'Ping'|'CSPViolationReport'|'Other'} ResourceType
 */

/**
 * @typedef {string} FrameId
 */

/**
 * @typedef CDPRequest
 * @property {string} url
 * @property {import('puppeteer').HttpMethod} method
 * @property {object} headers
 * @property {ResourcePriority} initialPriority
 * @property {string} postData
 */

/**
 * @typedef CDPResponse
 * @property {string} url
 * @property {number} status
 * @property {object} headers
 * @property {string} remoteIPAddress
 * @property {object} securityDetails
 */