// https://developer.scrypted.app/#getting-started
import axios from 'axios';
import sdk from "@scrypted/sdk";
const { scriptSettings } = sdk;
const { log, deviceManager, mediaManager } = sdk;
import url from 'url';
import qs from 'query-string';
import EventSource from 'eventsource';

const client_id = 'e09f8ecf-f1d4-4e22-9859-4b2d78f7ae35';
const client_secret = 'dtvcL9UCZxV91lXOjoataZzLG';
const redirect_uri = 'https://home.scrypted.app/web/oauth/callback';

var access_token = scriptSettings.getString('access_token');
if (!access_token) {
    log.a('Nest account is not authorized. Click the Authorize button to log in.');
}
else {
    console.log(access_token);
    log.clearAlerts();
}

class NestThermostat {
    constructor(device) {
        this.device = device;
        this.state = deviceManager.getDeviceState(this.device.device_id);
    }
    getHumidityAmbient() {
        return this.device.humidity;
    }
    getTemperatureAmbient() {
        return this.device.ambient_temperature_c;
    }
    getTemperatureUnit() {
        return this.device.temperature_scale;
    }
    sendEvents() {
        this.state.temperature = this.device.ambient_temperature_c;
        this.state.temperatureUnit = this.device.temperature_scale;
        // deviceManager.onDeviceEvent(this.device.device_id, 'Thermometer', this.getTemperatureAmbient());
        // deviceManager.onDeviceEvent(this.device.device_id, 'HumiditySensor', this.getHumidityAmbient());
    }
}

class NestCamera {
    constructor(device) {
        this.device = device;
        this.last_event = JSON.stringify(device.last_event);
    }
    sendEvents() {
        var thisEvent = JSON.stringify(this.device.last_event);
        if (thisEvent == this.last_event) {
            return;
        }
        this.last_event = thisEvent;

        if (this.device.last_event.has_sound) {
            deviceManager.onDeviceEvent(this.device.device_id, 'AudioSensor', true);
        }
        if (this.device.last_event.has_motion) {
            deviceManager.onDeviceEvent(this.device.device_id, 'MotionSensor', true);
        }
        if (this.device.last_event.has_person) {
            deviceManager.onDeviceEvent(this.device.device_id, 'OccupancySensor', true);
        }
    }
    takePicture() {
        var promise = (async () => {
            var request = `https://developer-api.nest.com/devices/cameras/${this.device.device_id}/snapshot_url`;
            const options = {
                responseType: 'text',
                headers: {
                    Accept: 'text/string',
                    Authorization: `Bearer ${access_token}`
                }
            };
            // log.i(request);
            var snapshot = await axios.get(request, options)
            .catch(e => {
                // 307 redirect from nest.
                // grab the response URL, and call it again with the authorization
                return axios.get(e.response.request.responseURL, options);
            })
            log.i(`snapshot: ${snapshot.data}`);
            return snapshot.data;
        })();
        return mediaManager.createMediaObject(promise, 'image/*');
    }
}

class NestController {
    constructor() {
        this._isOn = false;
        this.sync();
        this.devices = {};
    }
    startStreaming() {
        const options = {
            headers: {
                Authorization: `Bearer ${access_token}`
            }
        };
        var source = new EventSource(this.endpoint, options);
    
        source.addEventListener('put', result => setImmediate(() => {
            result = JSON.parse(result.data);
            if (!result || !result.data || !result.data.devices) {
                log.e('empty event?');
                return;
            }

            log.i('nest event received');
            // log.i(JSON.stringify(result.data, null, 2));

            if (result.data.devices.cameras) {
                for (const [id, camera] of Object.entries(result.data.devices.cameras)) {
                    var device = this.devices[id];
                    if (!device) {
                        continue;
                    }
                    device.device = camera;
                    device.sendEvents();
                }
            }
            if (result.data.devices.thermostats) {
                for (const [id, thermostat] of Object.entries(result.data.devices.thermostats)) {
                    var device = this.devices[id];
                    if (!device) {
                        continue;
                    }
                    device.device = thermostat;
                    device.sendEvents();
                }
            }
        }));
    
        source.addEventListener('open', function(event) {
            console.log('Streaming connection opened.');
        });
    
        source.addEventListener('auth_revoked', function(event) {
            console.log('Authentication token was revoked.');
            // Re-authenticate your user here.
        });
    
        source.addEventListener('error', function(event) {
            if (event.readyState == EventSource.CLOSED) {
                console.error('Connection was closed!', event);
            } else {
                console.error('An unknown error occurred: ', event);
            }
        }, false);
    }
    sync() {
        if (!access_token) {
            return;
        }
        console.log('syncing');
        const options = {
            headers: {
                Authorization: `Bearer ${access_token}`
            }
        };

        axios.get('https://developer-api.nest.com', options)
        .catch(e => {
            // 307 redirect from nest.
            // grab the response URL, and call it again with the authorization
            this.endpoint = e.response.request.responseURL;
            return axios.get(this.endpoint, options);
        })
        .catch(e => {
            log.e(`There was an error syncing your nest devices ${e}`);
            throw e;
        })
        .then(result => {
            var devices = [];
            if (result.data.devices.cameras) {
                for (const [id, camera] of Object.entries(result.data.devices.cameras)) {
                    this.devices[id] = new NestCamera(camera);
                    devices.push({
                        nativeId: id,
                        name: camera.name_long,
                        type: 'Camera',
                        interfaces: ['Camera'],
                        events: ['OccupancySensor', 'MotionSensor', 'AudioSensor'],
                    });
                }
            }
            if (result.data.devices.thermostats) {
                for (const [id, thermostat] of Object.entries(result.data.devices.thermostats)) {
                    this.devices[id] = new NestThermostat(thermostat);
                    devices.push({
                        nativeId: id,
                        name: thermostat.name_long,
                        type: 'Thermostat',
                        interfaces: ['Thermometer', 'HumiditySensor'],
                        events: ['Thermometer', 'HumiditySensor'],
                    });
                }
            }
            deviceManager.onDevicesChanged({
                devices,
            });
            // log.i(JSON.stringify(result.data, null, 2));

            this.startStreaming();
        })
    }
    getOauthUrl() {
        // redirect uri has a default, no need to pass it.
        return `https://home.nest.com/login/oauth2?client_id=${client_id}`
    }
    getDevice(id) {
        return this.devices[id];
    }
    async onOauthCallback(callbackUrl) {
        const query = qs.parse(url.parse(callbackUrl).search);
        const { code } = query;
        var result = await axios.post('https://api.home.nest.com/oauth2/access_token', qs.stringify({
            client_id,
            client_secret,
            code,
            grant_type: 'authorization_code',
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log('done');
        access_token = result.data.access_token;
        log.i(`${JSON.stringify(result.data)}`);
        scriptSettings.putString('access_token', access_token);
        log.clearAlerts();
    }
}

const controller = new NestController();

export default controller;
