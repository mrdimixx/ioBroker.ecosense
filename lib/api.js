'use strict';

/**
 * Minimal client for the EcoSense cloud (EcoQube radon monitors).
 *
 * The EcoSense app authenticates against an AWS Cognito user pool (SRP flow)
 * and then calls a REST endpoint with the resulting ID token.
 * There is no official, documented API – endpoints may change without notice.
 */

const { AuthenticationDetails, CognitoUser, CognitoUserPool } = require('amazon-cognito-identity-js');

const USER_POOL_ID = 'us-west-2_vB73oNa7f';
const CLIENT_ID = '1dk9ul54cdo42lt6e9u1oa9g1d';
const API_URL = 'https://api.cloud.ecosense.io/api/v1/device';
const REQUEST_TIMEOUT_MS = 30000;

class EcoSenseAuthError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'EcoSenseAuthError';
        this.code = code;
    }
}

class EcoSenseApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'EcoSenseApiError';
        this.status = status;
    }
}

class EcoSenseClient {
    /**
     * @param {string} email    EcoSense account (e-mail address used in the app)
     * @param {string} password EcoSense account password
     */
    constructor(email, password) {
        this.email = (email || '').trim();
        this.password = password || '';
        this.pool = new CognitoUserPool({ UserPoolId: USER_POOL_ID, ClientId: CLIENT_ID });
        this.user = null;
        this.session = null;
    }

    /**
     * Full login with username/password (SRP).
     *
     * @returns {Promise<void>}
     */
    login() {
        const user = new CognitoUser({ Username: this.email, Pool: this.pool });
        this.user = user;
        const details = new AuthenticationDetails({ Username: this.email, Password: this.password });

        return new Promise((resolve, reject) => {
            user.authenticateUser(details, {
                onSuccess: session => {
                    this.session = session;
                    resolve();
                },
                onFailure: err => {
                    this.session = null;
                    if (!err?.code || err.code === 'TypeError' || err.name === 'TypeError') {
                        // amazon-cognito-identity-js throws a TypeError when the response is not a
                        // Cognito answer (no network, DNS, proxy, firewall ...)
                        reject(
                            new EcoSenseAuthError(
                                `Cognito login service not reachable or unexpected answer (${err?.message || err})`,
                                'NetworkError',
                            ),
                        );
                        return;
                    }
                    reject(new EcoSenseAuthError(err.message || String(err), err.code));
                },
                newPasswordRequired: () => {
                    reject(
                        new EcoSenseAuthError(
                            'Account requires a new password – please log in once with the EcoQube app',
                            'NewPasswordRequired',
                        ),
                    );
                },
                mfaRequired: () => {
                    reject(new EcoSenseAuthError('MFA is not supported', 'MfaRequired'));
                },
                totpRequired: () => {
                    reject(new EcoSenseAuthError('MFA is not supported', 'MfaRequired'));
                },
            });
        });
    }

    /**
     * Returns a valid ID token. Uses the refresh token when the ID token expired,
     * falls back to a full login when that fails.
     *
     * @returns {Promise<string>}
     */
    async getIdToken() {
        if (!this.user || !this.session) {
            await this.login();
        }
        const user = this.user;
        let session = this.session;
        if (!user || !session) {
            throw new EcoSenseAuthError('Login did not return a session', 'NoSession');
        }
        if (!session.isValid()) {
            try {
                const refreshToken = session.getRefreshToken();
                session = await new Promise((resolve, reject) => {
                    user.refreshSession(refreshToken, (err, s) => (err ? reject(err) : resolve(s)));
                });
                this.session = session;
            } catch {
                await this.login();
                session = this.session;
                if (!session) {
                    throw new EcoSenseAuthError('Login did not return a session', 'NoSession');
                }
            }
        }
        return session.getIdToken().getJwtToken();
    }

    /**
     * @param {string} token
     * @returns {Promise<Array<Record<string, any>>>}
     */
    async _requestDevices(token) {
        const url = `${API_URL}?email=${encodeURIComponent(this.email)}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(url, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) {
            throw new EcoSenseApiError(`HTTP ${res.status} ${res.statusText}`, res.status);
        }
        const data = await res.json();
        if (Array.isArray(data)) {
            return data;
        }
        // be tolerant if the API ever wraps the list
        if (data && typeof data === 'object' && 'devices' in data && Array.isArray(data.devices)) {
            return data.devices;
        }
        if (data && typeof data === 'object') {
            return [data];
        }
        return [];
    }

    /**
     * Fetch all devices of the account. Retries once with a fresh login on 401/403.
     *
     * @returns {Promise<Array<Record<string, any>>>}
     */
    async getDevices() {
        const token = await this.getIdToken();
        try {
            return await this._requestDevices(token);
        } catch (err) {
            if (err instanceof EcoSenseApiError && (err.status === 401 || err.status === 403)) {
                this.session = null;
                return this._requestDevices(await this.getIdToken());
            }
            throw err;
        }
    }
}

/**
 * Fields of the device record that contain personal data (account e-mail, public IP,
 * Wi-Fi name, address/location). They are never written to states or logs.
 */
const PRIVATE_FIELDS = ['email', 'external_ip', 'wifi_name', 'geohash', 'geo_cdnt', 'device_location'];

/**
 * Returns a copy of a device record without personal data.
 *
 * @param {Record<string, unknown>} device
 * @returns {Record<string, unknown>}
 */
function sanitizeDevice(device) {
    const copy = { ...device };
    for (const key of PRIVATE_FIELDS) {
        delete copy[key];
    }
    return copy;
}

/**
 * Time of the last radon measurement in ms since epoch, or null.
 * The cloud delivers "last_radon_update_time" as UTC without time zone
 * and "last_update_ts" in seconds.
 *
 * @param {Record<string, unknown>} device
 * @returns {number | null}
 */
function measurementTime(device) {
    for (const key of ['last_radon_update_time', 'last_update_time']) {
        const v = device[key];
        if (typeof v === 'string' && v) {
            const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`;
            const t = Date.parse(iso);
            if (Number.isFinite(t)) {
                return t;
            }
        }
    }
    const ts = Number(device.last_update_ts);
    if (Number.isFinite(ts) && ts > 0) {
        return ts < 1e12 ? ts * 1000 : ts;
    }
    return null;
}

module.exports = {
    EcoSenseClient,
    EcoSenseAuthError,
    EcoSenseApiError,
    API_URL,
    PRIVATE_FIELDS,
    sanitizeDevice,
    measurementTime,
};
