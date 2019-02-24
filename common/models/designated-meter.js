'use strict';
const https = require('https');

const moment = require('moment-timezone');
const async = require('async');
const app = require('../../server/server.js');
const Meters = app.loopback.getModel('Meter');
const Constants = require('./../../server/constants.json');
const EDS = require('../../server/modules/eds-connector');
const WS = require('../../server/boot/websockets');
var Socket = new WS;
const Converter = require('xml-js');

const API_PREFIX = "/services/user/";
const DEFAULT_HOURS = 24;
const DEFAULT_DAYS = 1;
const CHARGE_FACTOR = Constants.CFE.values.charge_factor;

const XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;

const OPTIONS_XML2JS  = {
    compact: true,
    spaces: 4
}
const OPTIONS_JS2XML = {
    indentAttributes: true,
    spaces: 2,
    compact: true,
    fullTagEmptyElement:false
};

moment.tz.setDefault("America/Mexico_City");
const timezone = 'America/Mexico_City';

const fpFormula = function(P, Q) {
    return P/Math.sqrt(Math.pow(P, 2) + Math.pow(Q, 2));
}


module.exports = function(Designatedmeter) {

    Designatedmeter.consumptionSummary = function consumptionSummary(company_id, cb) {
        let devicesDescription = {};
        Meters.getActivesAssigned(company_id, function(err, meters) {
            async.eachSeries(meters, function(meter, next){
                const services = meter.services();
                async.each(services, (service, nextService) => {
                    let xhr = new XMLHttpRequest();
                    let dates = EDS.dateFilterSetup(Constants.Meters.filters.month);
                    let serviceToCall = meter.hostname+ API_PREFIX +"records.xml"+"?begin="+dates.begin+"?end="+dates.end;
                    service.devices.forEach((device, index) => {
                        if (index !== 0) {
                            devicesDescription[device.name] = device.description;
                            serviceToCall += "?var="+ device.name + ".EPimp";
                        }
                    });
                    serviceToCall += "?period="+dates.period;
                    xhr.open('GET', serviceToCall);
                    setTimeout(() => {
                        if (xhr.readyState < 3) {
                            xhr.abort();
                        }
                    }, 4000);
                    xhr.onload = function(){
                        if (xhr.readyState === 4 && xhr.status === 200) {
                            var reading = Converter.xml2js(xhr.responseText, OPTIONS_XML2JS);
                            if(reading.recordGroup && reading.recordGroup.record){
                                let read = {};
                                let iterable = [];
                                if (!Array.isArray(reading.recordGroup.record)) {
                                    iterable.push(reading.recordGroup.record);
                                } else {
                                    iterable = reading.recordGroup.record;
                                }
                                iterable.map((item) => {
                                    let key = 0;
                                    let itemIterable = [];
                                    if (!Array.isArray(item.field)) {
                                        itemIterable.push(item.field);
                                    } else {
                                        itemIterable = item.field;
                                    }
                                    for (let device of itemIterable) {
                                        const name = devicesDescription[device.id._text.split(".")[0]];
                                        const value = parseInt(device.value._text);
                                        if (!read[key]) {
                                            read[key] = {};
                                            read[key].value = 0;
                                        }
                                        read[key].device = name;
                                        read[key].value += value;
                                        key++;
                                    }
                                });
                                let consumptionSummatory = {}
                                Object.keys(read).forEach(key => {
                                    consumptionSummatory[key] = read[key];
                                });
        
                                let company_id = meter.company().id;
                                service.updateAttribute(
                                    "consumptionSummary",
                                    consumptionSummatory, (err, updated) => {
                                        if(err) return nextService(err);
                                        let socketData = {
                                            socketEvent: 'consumptionSummary',
                                            data: updated.consumptionSummary,
                                            service: updated.serviceName
                                        };
                                        socketData = JSON.stringify(socketData);
                                        Socket.sendMessageToCompanyUsers(company_id, socketData);
                                        nextService();
                                });
                            }
                        } else if (xhr.readyState === 4 && xhr.status !== 200) {
                            var reading = {};
                            nextService();
                        }
                    };
                    xhr.onerror = function() {
                        if (meters.length === 1) nextService({ status: 500, message: 'Error al leer medidor' });
                        else nextService();
                    };
                    xhr.onabort = function () {
                        console.error("The request timed out in consumption summary");
                    };
                    xhr.send();
                }, function(errService) {
                    if (errService) next(errService)
                    else next();
                });
            }, function(_err) {
                if(_err) {
                    console.log('error reading', _err);
                    cb(_err, null);
                }
                cb(null, 'OK');
            });
        });
    };

    Designatedmeter.remoteMethod(
        'consumptionSummary', {
            accepts: [
                { arg: 'company_id', type: 'string',  required: false, default: ''}
            ],
            returns: { arg: 'response', type: 'string' } 
        }
    );

    Designatedmeter.dailyReadings = function dailyReadings(company_id, cb) {
        Meters.getActivesAssigned(company_id, function(err, meters) {
            async.eachSeries(meters, function(meter, next){
                const services = meter.services();
                async.each(services, (service, nextService) => {
                    let xhr = new XMLHttpRequest();
                    var dates = EDS.dateFilterSetup(Constants.Meters.filters.dayAVG);
                    let serviceToCall = meter.hostname+ API_PREFIX +"records.xml" + "?begin=" +dates.begin+ "?end="
                        +dates.end;
                    service.devices.forEach((device, index) => {
                        if (index !== 0) {
                            serviceToCall += "?var="+ device.name + ".EPimp";
                        }
                    });
                    serviceToCall = serviceToCall + "?period=" + dates.period;
                    // console.log('service to call:', serviceToCall);
                    xhr.open('GET', serviceToCall);
                    setTimeout(() => {
                        if (xhr.readyState < 3) {
                            xhr.abort();
                        }
                    }, 4000);
                    xhr.onload = function(){
                        if (xhr.readyState === 4 && xhr.status === 200) {
                            var reading = Converter.xml2js(xhr.responseText, OPTIONS_XML2JS);
                            let summatory = 0;
                            if(reading.recordGroup && reading.recordGroup.record){
                                let iterable = [];
                                if (!Array.isArray(reading.recordGroup.record.field)) {
                                    iterable.push(reading.recordGroup.record.field);
                                } else {
                                    iterable = reading.recordGroup.record.field;
                                }
                                iterable.map(item=> {
                                    summatory += parseFloat(item.value._text);
                                });
                                let distribution = ( parseInt(summatory) / (dates.hour * DEFAULT_DAYS * CHARGE_FACTOR) );
                                let consumption = summatory
                                let distributionCharge = distribution * Constants.CFE.values.distribution_price;
                                distribution = distribution.toFixed(2);
                                distributionCharge = distributionCharge.toFixed(2);
                                consumption = consumption.toFixed(2);

                                let dailyReadings = {};
                                dailyReadings.lastUpdated = moment().format();

                                dailyReadings.distribution = distribution;
                                dailyReadings.chargeDistribution = distributionCharge;

                                dailyReadings.consumption = consumption;

                                let company_id = meter.company().id;

                                Meters.getDpReadingsByFilter(meter.meter_id, '', service.serviceName, 0, {}, (err, res) => {
                                    let maxDp = 0;
                                    res.forEach((dpReading) => {
                                        if (dpReading.isPeak && parseFloat(dpReading.value) > maxDp) {
                                            maxDp = parseFloat(dpReading.value);
                                        }
                                    });
                                    dailyReadings.capacity = Math.min(maxDp, parseFloat(distribution));

                                    service.updateAttribute(
                                        "dailyReadings",
                                        dailyReadings, (err, updated) => {
                                            if(err) return nextService(err);
                                            let socketData = {
                                                socketEvent: 'dailyReading',
                                                data: updated.dailyReadings,
                                                service: updated.serviceName
                                            };
                                            socketData = JSON.stringify(socketData);
                                            Socket.sendMessageToCompanyUsers(company_id, socketData);
                                            nextService();
                                    });
                                });
                            } else {
                                nextService();
                            }
                        } else if (xhr.readyState === 4 && xhr.status !== 200) {
                            nextService();
                        }
                    };
                    xhr.onerror = function() {
                        if (meters.length === 1) nextService({ status: 500, message: 'Error al leer medidor' });
                        else nextService();
                    };
                    xhr.onabort = function () {
                        console.error("The request timed out in daily readings");
                    };
                    xhr.send();
                }, function(errService) {
                    if (errService) next(errService)
                    else next();
                });
            }, function(_err) {
                if(_err) {
                    console.log('error reading', _err);
                    cb(_err, null);
                }
                cb(null, 'OK');
            });
        });
    };

    Designatedmeter.remoteMethod(
        'dailyReadings', {
            accepts: [
                { arg: 'company_id', type: 'string',  required: false, default: ''}
            ],
            returns: { arg: 'response', type: 'string' }
        }
    );

    Designatedmeter.epimpHistory = function epimpHistory(company_id, cb) {
        Meters.getActivesAssigned(company_id, function(err, meters) {
            async.eachSeries(meters, function(meter, next){
                const services = meter.services();
                async.each(services, (service, nextService) => {
                    let xhr = new XMLHttpRequest();
                    let dates = EDS.dateFilterSetup(Constants.Meters.filters.month);
                    let serviceToCall = meter.hostname+ API_PREFIX +"records.xml" + "?begin=" +dates.begin+ "?end="+dates.end;
                    service.devices.forEach((device, index) => {
                        if (index !== 0) {
                            serviceToCall += "?var="+ device.name + ".EPimp";
                        }
                    });
                    serviceToCall += "?period=" +dates.period;
                    xhr.open('GET', serviceToCall);
                    setTimeout(() => {
                        if (xhr.readyState < 3) {
                            xhr.abort();
                        }
                    }, 4000);
                    xhr.onload = function(){
                        if (xhr.readyState === 4 && xhr.status === 200) {
                            let reading = Converter.xml2js(xhr.responseText, OPTIONS_XML2JS);
                            if (reading.recordGroup && reading.recordGroup.record) {
                                let epimp = {};
                                reading.recordGroup.record.map( (item, key) => {
                                    let read = {};
                                    if(item.field){
                                        read.value = 0;
                                        item.field.map(device => {
                                            read.value += parseFloat(device.value._text);
                                        });
                                        read.value = read.value.toFixed(2);
                                    } else {
                                        read.value = "0";
                                    }
                                    read.date = item.dateTime._text;
                                    epimp[key] = read;
                                });
                                let company_id = meter.company().id;

                                service.updateAttribute("epimp", epimp, (err, updated) => {
                                    if (err) return nextService(err);
                                    let socketData = {
                                        socketEvent: 'epimpHistoryReading',
                                        data: updated.epimp,
                                        service: updated.serviceName
                                    };
                                    socketData = JSON.stringify(socketData);
                                    Socket.sendMessageToCompanyUsers(company_id, socketData);
                                    nextService();
                                });
                            }
                        } else if (xhr.readyState === 4 && xhr.status !== 200) {
                            nextService();
                        }
                    };
                    xhr.onerror = function() {
                        if (meters.length === 1) nextService({ status: 500, message: 'Error al leer medidor' });
                        else nextService();
                    };
                    xhr.onabort = function () {
                        console.error("The request timed out in epimpHistory");
                    };
                    xhr.send();
                }, function(errService) {
                    if (errService) next(errService)
                    else next();
                });
            }, function(_err) {
                if(_err) {
                    console.log('error reading', _err);
                    cb(_err, null);
                }
                cb(null, 'OK');
            });
        });
    };

    Designatedmeter.remoteMethod(
        'epimpHistory', {
            accepts: [
                { arg: 'company_id', type: 'string',  required: false, default: ''}
            ],
            returns: { arg: 'response', type: 'string' }
        }
    );

    Designatedmeter.fpReadings = function fpReadings(company_id, cb) {
        Meters.getActivesAssigned(company_id, function(err, meters) {
            async.eachSeries(meters, function(meter, next){
                const services = meter.services();
                async.each(services, (service, nextService) => {
                    let xhr = new XMLHttpRequest();
                    var dates = EDS.dateFilterSetup(Constants.Meters.filters.monthAVG);
                    let serviceToCall = meter.hostname+ API_PREFIX +"records.xml" + "?begin=" +dates.begin+ "?end=" +dates.end 
                    service.devices.forEach((device, index) => {
                        if (index !== 0) {
                            serviceToCall += "?var="+device.name+".EPimp"+"?var="+device.name+".EQimp";
                        }
                    });
                    serviceToCall += "?period=" + dates.period;
        
                    // console.log('service to call:', serviceToCall);
                    xhr.open('GET', serviceToCall);
                    setTimeout(() => {
                        if (xhr.readyState < 3) {
                            xhr.abort();
                        }
                    }, 4000);
                    xhr.onload = function(){
                        if (xhr.readyState === 4 && xhr.status === 200) {
                            const reading = Converter.xml2js(xhr.responseText, OPTIONS_XML2JS);
                            let P = 0;
                            let Q = 0;
                            if(reading.recordGroup.record){
                                let iterate = reading.recordGroup.record;
                                if (Array.isArray(iterate)) {
                                    iterate = iterate[0];
                                }
                                iterate.field.map(read => {
                                    const type = read.id._text.split('.')[1];
                                    let value = parseFloat(read.value._text);
                                    if (type === 'EPimp') {
                                        P += value;
                                    } else {
                                        Q += value;
                                    }
                                });
                                const fp = (fpFormula(P, Q)*100).toFixed(2);
                                const reactive = Q.toFixed(2);
        
                                let company_id = meter.company().id;

                                service.updateAttributes({
                                    fp,
                                    reactive
                                }, (err, updated) => {
                                    if(err) return nextService(err);
                                    let socketData = {
                                        socketEvent: 'powerFactor',
                                        data: updated.fp,
                                        service: updated.serviceName
                                    };
                                    socketData = JSON.stringify(socketData);
                                    Socket.sendMessageToCompanyUsers(company_id, socketData);
                                    socketData = {
                                        socketEvent: 'reactive',
                                        data: updated.reactive,
                                        service: updated.serviceName
                                    };
                                    socketData = JSON.stringify(socketData);
                                    Socket.sendMessageToCompanyUsers(company_id, socketData);
                                    nextService();
                                });
                            } else {
                                nextService();
                            }
                        } else if (xhr.readyState === 4 && xhr.status !== 200) {
                            nextService();
                        }
                    };
                    xhr.onerror = function() {
                        if (meters.length === 1) nextService({ status: 500, message: 'Error al leer medidor' });
                        else nextService();
                    };
                    xhr.onabort = function () {
                        console.error("The request timed out in fpReadings");
                    };
                    xhr.send();
                }, function(errService) {
                    if (errService) next(errService)
                    else next();
                });
            }, function(_err) {
                if(_err) {
                    console.log('error reading', _err);
                    cb(_err, null);
                }
                cb(null, 'OK');
            });
        });
    };

    Designatedmeter.remoteMethod(
        'fpReadings', {
            accepts: [
                { arg: 'company_id', type: 'string',  required: false, default: ''}
            ],
            returns: { arg: 'response', type: 'string' }
        }
    );

    Designatedmeter.monthlyReadings = function monthlyReadings(company_id, cb) {
        Meters.getActivesAssigned(company_id, function(err, meters) {
            async.eachSeries(meters, function(meter, next){
                const services = meter.services();
                async.each(services, (service, nextService) => {
                    let xhr = new XMLHttpRequest();
                    var dates = EDS.dateFilterSetup(Constants.Meters.filters.monthAVG);
                    let serviceToCall = meter.hostname+ API_PREFIX +"records.xml" + "?begin=" +dates.begin+ "?end="
                        +dates.end;
                    service.devices.forEach((device, index) => {
                        if (index !== 0) {
                            serviceToCall += "?var="+ device.name + ".EPimp";
                        }
                    });
                    serviceToCall = serviceToCall + "?period=" + dates.period;
                    xhr.open('GET', serviceToCall);
                    setTimeout(() => {
                        if (xhr.readyState < 3) {
                            xhr.abort();
                        }
                    }, 4000);
                    xhr.onload = function(){
                        if (xhr.readyState === 4 && xhr.status === 200) {
                            var reading = Converter.xml2js(xhr.responseText, OPTIONS_XML2JS);
                            let summatory = 0;
                            if(reading.recordGroup.record){
                                let iterate = reading.recordGroup.record;
                                if (Array.isArray(iterate)) {
                                    iterate = iterate[0];
                                }
                                if (!Array.isArray(iterate.field)) {
                                    iterate = [iterate.field];
                                } else {
                                    iterate = iterate.field;
                                }
                                Object.keys(iterate).forEach(function(key) {
                                    summatory += parseInt(iterate[key].value._text);
                                });
                                
                                let consumption = parseInt(summatory);
                                let distribution = ( consumption / (DEFAULT_HOURS * dates.day * CHARGE_FACTOR) );
                                
                                distribution = distribution.toFixed(2);
                                consumption = consumption.toFixed(2);

                                let monthlyReadings = {};

                                monthlyReadings.distribution = distribution;
                                monthlyReadings.consumption = consumption;

                                let company_id = meter.company().id;
                                Meters.getDpReadingsByFilter(meter.meter_id, '', service.serviceName, 3, {}, (err, res) => {
                                    let maxDp = 0;
                                    res.forEach((dpReading) => {
                                        if (dpReading.isPeak && parseFloat(dpReading.value) > maxDp) {
                                            maxDp = parseFloat(dpReading.value);
                                        }
                                    });

                                    monthlyReadings.capacity = Math.min(maxDp, parseFloat(distribution));

                                    service.updateAttribute("monthlyReadings", monthlyReadings, (err, updated) => {
                                        if(err) return nextService(err);
                                        let socketData = {
                                            socketEvent: 'monthlyReading',
                                            data: updated.monthlyReadings,
                                            service: updated.serviceName
                                        };
                                        socketData = JSON.stringify(socketData);
                                        Socket.sendMessageToCompanyUsers(company_id, socketData);
                                        nextService();
                                    });
                                });
                            } else {
                                nextService();
                            }
                        } else if (xhr.readyState === 4 && xhr.status !== 200) {
                            var reading = {};
                            nextService();
                        }
                    };
                    xhr.onerror = function() {
                        if (meters.length === 1) nextService({ status: 500, message: 'Error al leer medidor' });
                        else nextService();
                    };
                    xhr.onabort = function () {
                        console.error("The request timed out in monthly readings");
                    };
                    xhr.send();
                }, function(errService) {
                    if (errService) next(errService)
                    else next();
                });
            }, function(_err) {
                if(_err) {
                    console.log('error reading', _err);
                    cb(_err, null);
                }
                cb(null, 'OK');
            });
        });
    }

    Designatedmeter.remoteMethod(
        'monthlyReadings', {
            accepts: [
                { arg: 'company_id', type: 'string',  required: false, default: ''}
            ],
            returns: { arg: 'response', type: 'string' }
        }
    );

    Designatedmeter.odometerReadings = function odometerReadings(company_id, cb) {
        Meters.getActivesAssigned(company_id, function(err, meters) {
            async.eachSeries(meters, function(meter, next){
                const services = meter.services();
                async.each(services, (service, nextService) => {
                    let xhr = new XMLHttpRequest();
                    let serviceToCall = meter.hostname+ API_PREFIX +"values.xml" + "?var=" +meter.summatory_device+ "." +Constants.Meters.common_names.summatory_dp;

                    xhr.open('GET', serviceToCall);
                    setTimeout(() => {
                        if (xhr.readyState < 3) {
                            xhr.abort();
                        }
                    }, 4000);
                    xhr.onload = function(){
                        if (xhr.readyState === 4 && xhr.status === 200) {
                            var reading = Converter.xml2js(xhr.responseText, OPTIONS_XML2JS);
                            let dp = ( parseFloat(reading.values.variable.value._text) / 1000 );
                            if(dp){
                                dp = dp.toFixed(2);
                                
                                let company_id = meter.company().id;

                                service.updateAttribute("dp", dp, (err, updated) => {
                                    if (err) return nextService(err)
                                    let socketData = {
                                        socketEvent: 'odometerReading',
                                        data: updated.dp,
                                        service: updated.serviceName
                                    };
                                    socketData = JSON.stringify(socketData);
                                    Socket.sendMessageToCompanyUsers(company_id, socketData);
                                    nextService();
                                });
                            } else {
                                nextService();
                            }
                        } else if (xhr.readyState === 4 && xhr.status !== 200) {
                            var reading = {};
                            nextService();
                        }
                    };
                    xhr.onerror = function() {
                        if (meters.length === 1) nextService({ status: 500, message: 'Error al leer medidor' });
                        else nextService();
                    };
                    xhr.onabort = function () {
                        console.error("The request timed out in odometerReadings");
                    };
                    xhr.send();
                }, function(errService) {
                    if (errService) next(errService)
                    else next();
                });
            }, function(_err) {
                if(_err) {
                    console.log('error reading', _err);
                    cb(_err, null);
                }
                cb(null, 'OK');
            });
        });
    };

    Designatedmeter.remoteMethod(
        'odometerReadings', {
            accepts: [
                { arg: 'company_id', type: 'string',  required: false, default: ''}
            ],
            returns: { arg: 'response', type: 'string' }
        }
    );

    Designatedmeter.getWeather = function getWeather(lat, lon, cb) {
        const API_URL = 'da79653f5a5cf0558734cee7b31bd0d7';
        let url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&units=metric&lang=es&APPID=${API_URL}`;

        let req = https.get(url, (resp) => {
            let data = '';
            resp.setEncoding('utf8');
            
            resp.on('data', (chunk) => {
                data += chunk;
            });
            
            // When the information has been received, send it back
            resp.on('end', () => {
                cb(null, JSON.parse(data));
            });
        });

        req.on('error', (err) => {
            cb({ status: 500, message: 'Couldnt retrieve data from weather api' });
        })
    };

    Designatedmeter.remoteMethod(
        'getWeather', {
            accepts: [
                { arg: 'lat', type: 'number' },
                { arg: 'lon', type: 'number' }
            ],
            returns: { arg: 'results', type: 'object' }
    });

    Designatedmeter.setDeviceDescriptions = function setDeviceDescription(meterId, cb) {
        const DesignatedMeter = app.loopback.getModel('DesignatedMeter');
        DesignatedMeter.find({
            where: {
                id: meterId
            }
        })
            .then(meters => {
                async.each(meters, (meter, next) => {
                    let serviceToCall = meter.hostname+API_PREFIX+'deviceInfo.xml';
                    meter.devices.forEach((device, index) => {
                        let id = device;
                        if (device.name && device.description) {
                            id = device.name;
                        }
                        serviceToCall += `?id=${id}`;
                    });
                    let xhr = new XMLHttpRequest();
                    xhr.open('GET', serviceToCall);
                    setTimeout(() => {
                        if (xhr.readyState < 3) {
                            xhr.abort();
                        }
                    }, 4000);
                    xhr.onload = function() {
                        if (xhr.readyState === 4 && xhr.status === 200) {
                            const reading = Converter.xml2js(xhr.responseText, OPTIONS_XML2JS);
                            meter.devices = reading.devices.device.map(device => 
                                ({
                                    name: device.id._text,
                                    description: (device.description)? device.description._text: 'EDS'
                                })
                            );
                            meter.devices.push()
                            meter.save(function(err, dsgMeter){
                                next();
                            });
                        } else if (xhr.readyState === 4 && xhr.status !== 200) {
                            next();
                        }
                    }
                    xhr.onerror = function() {
                        console.log('An error occurred while opening the request');
                        next();
                    };
                    xhr.send();
                }, (err => {
                    if (err) return cb({ status: 501, message: 'Error al guardar descripción de un dispositivo' });
                    cb(null, 'OK');
                }));
            });
    }

    Designatedmeter.remoteMethod(
        'setDeviceDescriptions', {
            accepts: [
                {arg: 'meterId', type: 'string', required: false}
            ],
            returns: {arg: 'result', type: 'string'}
        }
    );
};
