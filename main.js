'use strict';

/*
 * ioBroker.ecosense – EcoSense EcoQube radon monitors via the EcoSense cloud
 */

const utils = require('@iobroker/adapter-core');
const { EcoSenseClient, EcoSenseAuthError, sanitizeDevice, measurementTime } = require('./lib/api');

const PCI_FACTOR = 37; // 1 pCi/L = 37 Bq/m³
const MIN_INTERVAL_MIN = 5;
const LEVEL_TEXT = { 0: 'green', 1: 'orange', 2: 'red' };
// Cognito errors that will not go away by retrying
const FATAL_AUTH_CODES = ['NotAuthorizedException', 'UserNotFoundException', 'NewPasswordRequired', 'MfaRequired'];

class Ecosense extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options = {}) {
        super({ ...options, name: 'ecosense' });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.client = null;
        this.pollTimer = null;
        this.intervalMs = 10 * 60 * 1000;
        this.levelWarn = 100;
        this.levelAlarm = 300;
        this.knownObjects = new Set();
        this.stopped = false;
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);

        const email = (this.config.email || '').trim();
        const password = this.config.password || '';
        if (!email || !password) {
            this.log.error('Please enter e-mail and password of your EcoSense account in the instance settings.');
            return;
        }

        let interval = parseInt(String(this.config.interval), 10) || 10;
        if (interval < MIN_INTERVAL_MIN) {
            this.log.warn(`Polling interval ${interval} min is too short, using ${MIN_INTERVAL_MIN} min.`);
            interval = MIN_INTERVAL_MIN;
        }
        this.intervalMs = interval * 60 * 1000;

        this.levelWarn = Number(this.config.levelWarn) || 100;
        this.levelAlarm = Number(this.config.levelAlarm) || 300;
        if (this.levelAlarm <= this.levelWarn) {
            this.log.warn('Alarm threshold must be higher than warning threshold – using 100 / 300 Bq/m³.');
            this.levelWarn = 100;
            this.levelAlarm = 300;
        }

        this.client = new EcoSenseClient(email, password);
        await this.poll();
    }

    scheduleNext() {
        if (this.stopped) {
            return;
        }
        this.pollTimer = this.setTimeout(() => {
            this.pollTimer = null;
            this.poll();
        }, this.intervalMs);
    }

    async poll() {
        try {
            if (!this.client) {
                return;
            }
            const devices = await this.client.getDevices();
            this.log.debug(`Received ${devices.length} device(s): ${JSON.stringify(devices.map(sanitizeDevice))}`);
            if (!devices.length) {
                this.log.warn('No EcoQube devices found in this EcoSense account.');
            }
            for (const device of devices) {
                await this.updateDevice(device);
            }
            await this.setStateAsync('info.connection', true, true);
            await this.setStateAsync('info.lastPoll', Date.now(), true);
        } catch (err) {
            await this.setStateAsync('info.connection', false, true);
            if (err instanceof EcoSenseAuthError && FATAL_AUTH_CODES.includes(err.code)) {
                this.log.error(
                    `Login to EcoSense cloud failed (${err.code}): ${err.message}. Please check e-mail and password – polling stopped.`,
                );
                return; // do not hammer the login with wrong credentials
            }
            this.log.warn(`Could not read data from EcoSense cloud: ${err.message}`);
        }
        this.scheduleNext();
    }

    /**
     * @param {Record<string, any>} device
     */
    async updateDevice(device) {
        const serial = String(device.serial_number ?? device.serialNumber ?? device.serial ?? device.id ?? '').trim();
        if (!serial) {
            this.log.warn('Ignoring device without serial number');
            return;
        }
        const devId = serial.replace(this.FORBIDDEN_CHARS, '_');
        const clean = sanitizeDevice(device);

        await this.ensureObject(devId, {
            type: 'device',
            common: { name: device.device_name || device.name || `EcoQube ${serial}` },
            native: { serial },
        });

        // radon – 0 means "no value yet" (device still initialising)
        const raw = Number(device.radon_level);
        const bq = Number.isFinite(raw) && raw > 0 ? Math.round(raw * 10) / 10 : null;
        const pci = bq === null ? null : Math.round((bq / PCI_FACTOR) * 100) / 100;
        let level = null;
        if (bq !== null) {
            level = bq < this.levelWarn ? 0 : bq < this.levelAlarm ? 1 : 2;
        }

        // device counts as online if it reported within 3 of its own upload periods
        const measured = measurementTime(device);
        const periodMin = Number(device.polling_period) > 0 ? Number(device.polling_period) : 10;
        const online = measured === null ? false : Date.now() - measured < periodMin * 3 * 60 * 1000;

        await this.writeState(`${devId}.radon`, bq, {
            name: 'Radon concentration',
            type: 'number',
            role: 'value',
            unit: 'Bq/m³',
        });
        await this.writeState(`${devId}.radonPci`, pci, {
            name: 'Radon concentration (pCi/L)',
            type: 'number',
            role: 'value',
            unit: 'pCi/L',
        });
        await this.writeState(`${devId}.alertLevel`, level, {
            name: 'Alert level (0 = green, 1 = orange, 2 = red)',
            type: 'number',
            role: 'value.warning',
            states: { 0: 'green', 1: 'orange', 2: 'red' },
            min: 0,
            max: 2,
        });
        await this.writeState(`${devId}.alertText`, level === null ? null : LEVEL_TEXT[level], {
            name: 'Alert level as text',
            type: 'string',
            role: 'text',
        });
        await this.writeState(`${devId}.lastMeasurement`, measured, {
            name: 'Time of the last measurement',
            type: 'number',
            role: 'value.time',
        });
        await this.writeState(`${devId}.online`, online, {
            name: 'Device uploaded data recently',
            type: 'boolean',
            role: 'indicator.reachable',
        });
        await this.writeState(`${devId}.firmware`, device.fw_version ?? null, {
            name: 'Firmware version',
            type: 'string',
            role: 'info.firmware',
        });
        await this.writeState(`${devId}.json`, JSON.stringify(clean), {
            name: 'Device data (without personal data)',
            type: 'string',
            role: 'json',
        });

        // everything else the API delivers ends up in "<serial>.raw.*"
        await this.ensureObject(`${devId}.raw`, {
            type: 'channel',
            common: { name: 'Raw values from the EcoSense cloud' },
            native: {},
        });
        for (const [key, value] of Object.entries(clean)) {
            if (value === null || typeof value === 'object') {
                continue;
            }
            const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
            const role = type === 'number' ? 'value' : type === 'boolean' ? 'indicator' : 'text';
            await this.writeState(`${devId}.raw.${key.replace(this.FORBIDDEN_CHARS, '_')}`, value, {
                name: key,
                type,
                role,
            });
        }
    }

    /**
     * @param {string} id
     * @param {any} obj
     */
    async ensureObject(id, obj) {
        if (this.knownObjects.has(id)) {
            return;
        }
        await this.extendObjectAsync(id, obj);
        this.knownObjects.add(id);
    }

    /**
     * @param {string} id
     * @param {any} val
     * @param {Record<string, any>} common
     */
    async writeState(id, val, common) {
        await this.ensureObject(id, {
            type: 'state',
            common: { read: true, write: false, ...common },
            native: {},
        });
        await this.setStateChangedAsync(id, val, true);
    }

    /**
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.stopped = true;
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
            this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Ecosense(options);
    module.exports.Ecosense = Ecosense; // for unit tests
} else {
    new Ecosense();
}
