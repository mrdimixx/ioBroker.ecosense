'use strict';

/* Unit tests with mocked HTTP – no EcoSense account needed */

const assert = require('assert');
const { EcoSenseClient, EcoSenseAuthError } = require('../lib/api');

// adapter-core needs a js-controller installation – replace it by a stub for unit tests
const corePath = require.resolve('@iobroker/adapter-core');
require.cache[corePath] = { id: corePath, filename: corePath, loaded: true, exports: { Adapter: class {} } };
const { Ecosense } = require('../main');

const realFetch = global.fetch;

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

function fakeSession(token) {
    return {
        isValid: () => true,
        getIdToken: () => ({ getJwtToken: () => token }),
        getRefreshToken: () => ({}),
    };
}

describe('EcoSenseClient', () => {
    afterEach(() => {
        global.fetch = realFetch;
    });

    it('sends the SRP login to the EcoSense Cognito pool and maps wrong credentials', async () => {
        let call;
        global.fetch = async (url, opts) => {
            call = { url, opts };
            return jsonResponse(400, { __type: 'UserNotFoundException', message: 'User does not exist.' });
        };
        const client = new EcoSenseClient('user@example.com', 'pw');
        await assert.rejects(client.login(), err => {
            assert.ok(err instanceof EcoSenseAuthError);
            assert.strictEqual(err.code, 'UserNotFoundException');
            return true;
        });
        assert.strictEqual(call.url, 'https://cognito-idp.us-west-2.amazonaws.com/');
        const body = JSON.parse(call.opts.body);
        assert.strictEqual(body.AuthFlow, 'USER_SRP_AUTH');
        assert.strictEqual(body.ClientId, '1dk9ul54cdo42lt6e9u1oa9g1d');
        assert.strictEqual(body.AuthParameters.USERNAME, 'user@example.com');
    });

    it('reports a readable error when Cognito is not reachable', async () => {
        global.fetch = async () => jsonResponse(403, { error: 'blocked by proxy' });
        const client = new EcoSenseClient('user@example.com', 'pw');
        await assert.rejects(client.login(), err => err.code === 'NetworkError');
    });

    it('reads the device list with the ID token', async () => {
        let call;
        global.fetch = async (url, opts) => {
            call = { url, opts };
            return jsonResponse(200, [{ serial_number: 'ABC123', radon_level: 42 }]);
        };
        const client = new EcoSenseClient('user@example.com', 'pw');
        client.user = {};
        client.session = fakeSession('TOKEN1');
        const devices = await client.getDevices();
        assert.deepStrictEqual(devices, [{ serial_number: 'ABC123', radon_level: 42 }]);
        assert.strictEqual(call.url, 'https://api.cloud.ecosense.io/api/v1/device?email=user%40example.com');
        assert.strictEqual(call.opts.headers.Authorization, 'Bearer TOKEN1');
    });

    it('logs in again once after HTTP 401', async () => {
        const tokens = [];
        global.fetch = async (url, opts) => {
            tokens.push(opts.headers.Authorization);
            return tokens.length === 1 ? jsonResponse(401, {}) : jsonResponse(200, []);
        };
        const client = new EcoSenseClient('user@example.com', 'pw');
        client.user = {};
        client.session = fakeSession('OLD');
        client.login = async () => {
            client.session = fakeSession('NEW');
        };
        await client.getDevices();
        assert.deepStrictEqual(tokens, ['Bearer OLD', 'Bearer NEW']);
    });
});

describe('Adapter state mapping', () => {
    function fakeAdapter() {
        const objects = {};
        const states = {};
        const ctx = Object.create(Ecosense.prototype);
        Object.assign(ctx, {
            FORBIDDEN_CHARS: /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu,
            knownObjects: new Set(),
            levelWarn: 100,
            levelAlarm: 300,
            log: { warn: () => {}, debug: () => {} },
            extendObjectAsync: async (id, obj) => {
                objects[id] = obj;
            },
            setStateChangedAsync: async (id, val) => {
                states[id] = val;
            },
        });
        return { ctx, objects, states };
    }

    it('creates radon, pCi/L, alert level and raw states', async () => {
        const { ctx, objects, states } = fakeAdapter();
        await ctx.updateDevice({ serial_number: 'EQ-1', radon_level: 148, firmware: '1.2', online: true });
        assert.strictEqual(objects['EQ-1'].type, 'device');
        assert.strictEqual(states['EQ-1.radon'], 148);
        assert.strictEqual(states['EQ-1.radonPci'], 4);
        assert.strictEqual(states['EQ-1.alertLevel'], 1);
        assert.strictEqual(states['EQ-1.alertText'], 'orange');
        assert.strictEqual(states['EQ-1.raw.firmware'], '1.2');
        assert.strictEqual(states['EQ-1.raw.online'], true);
        assert.strictEqual(objects['EQ-1.raw.online'].common.type, 'boolean');
    });

    it('uses the thresholds for green and red', async () => {
        const { ctx, states } = fakeAdapter();
        await ctx.updateDevice({ serial_number: 'A', radon_level: 99 });
        await ctx.updateDevice({ serial_number: 'B', radon_level: 300 });
        assert.strictEqual(states['A.alertLevel'], 0);
        assert.strictEqual(states['B.alertLevel'], 2);
    });

    it('treats 0 as "no value yet"', async () => {
        const { ctx, states } = fakeAdapter();
        await ctx.updateDevice({ serial_number: 'X', radon_level: 0 });
        assert.strictEqual(states['X.radon'], null);
        assert.strictEqual(states['X.alertLevel'], null);
    });

    it('replaces forbidden characters in the serial number', async () => {
        const { ctx, objects } = fakeAdapter();
        await ctx.updateDevice({ serial_number: 'EQ*1', radon_level: 50 });
        assert.ok(objects['EQ_1']);
    });
});
