'use strict';

const app = require('./../../server/server.js');
const Company = app.loopback.getModel('Company');
const Constants = require('./../../server/constants.json');
const WS = require('../../server/boot/websockets');
const Socket = new WS;

var moment = require('moment-timezone');

module.exports = function(Euser) {

    Euser.trialDaysLeft = function trialDaysLeft(id, cb) {
        Euser.findById(id, (err, user) => {
            if (err) return cb(err, null);
            if (!user) return cb({ status: 400, message: 'No user found' }, null);
            if (!("free_trial" in user)) return cb({status: 403, message: 'The user is not on free_trial period'}, null);
            if (user.free_trial !== true) return cb({status: 403, message: 'The user is not on free_trial period'}, null);
            let lastTrialDay = moment(user.created_at).add(Constants.Trial.days, 'days');
            let daysLeft = moment(lastTrialDay).diff(moment(), 'days');
            return cb(null, daysLeft);
        })
    }

    Euser.remoteMethod(
        'trialDaysLeft', {
        accepts: [
            { arg: 'id', type: 'string' },
        ],
        returns: { arg: 'days', type: 'number' },
        http: {path: '/trialDaysLeft', verb: 'get'}
    })

    Euser.updateMaximums = function updateMaximums(id, maximums, service, device, cb) {
        let message = '';
        let badRequest = false;
        if (!service && !device) {
            message += "Error: There's not a service/device selected to update their maximums. ";
            badRequest = true;
        }
        if (service && device) {
            message += "Error: Can update only one service/device at a time, choose one. ";
            badRequest = true;
        }
        if (!maximums) {
            message += "Error: maximums key-value pair is null. ";
            badRequest = true;
        }
        if (badRequest) {
            return cb({status: 400, message});
        }
        
        Euser.findOne({
            where: {
                and: [
                    {"id": id}
                ]
            },
            include: [
                {
                    relation: "company",
                    scope: {
                        include: [
                            {
                                relation: "meters",
                                scope: {
                                    include: {
                                        relation: "services"
                                    }
                                }
                            }
                        ]
                    }
                }
            ]
        }, (err, user) => {
            if (err) return cb({status: 400, message: err})
            if (!user) return cb({status: 400, message: 'User not found on PUT request api/eUsers/updateMaximums'})
            
            let company = user.company();
            let meter = company.meters()[0];
            let services = meter.services();
            let devices = meter.devices;
            console.log(devices);
            if (service) {
                let serviceExists = false;
                for (let element of services) {
                    console.log(element);
                    if(element.serviceName === service) {
                        serviceExists = true;
                        break;
                    }
                }
                if (serviceExists) {
                    user.settings[service] = maximums;
                } else {
                    badRequest = true;
                }
            } else {
                let deviceExists = false;
                for (let element of devices) {
                    if(element.name === device) {
                        deviceExists = true;
                        break;
                    }
                }
                if (deviceExists) {
                    user.settings[device] = maximums;
                } else {
                    badRequest = true;
                }
            }

            if (badRequest) {
                return cb({status: 400, message: "the service or device provided does not exists in the user's company"});
            }
            
            user.updateAttributes({"settings": user.settings}, (err, newInstance) => {
                if (err) return cb(err, null);
                return cb(null, {status: 200, newInstance: newInstance, message: 'Settings updated successfully'});
            });
        })
    }

    Euser.remoteMethod(
        'updateMaximums', {
            accepts: [
                { arg: 'id', type: 'string' },
                { arg: 'maximums', type: 'object'},
                { arg: 'service', type: 'string' },
                { arg: 'device', type: 'string'}
            ],
            returns: { arg: 'response', type: 'object'},
            http: {path: '/updateMaximums', verb: 'PUT'}
        }
    )

    Euser.beforeRemote('login', function(ctx, modelInstance, next) {
        if (!ctx.req.body.email || !ctx.req.body.password)
            return next({statusCode: 404, message: 'Datos insuficientes para iniciar sesión.'});
        Euser.findOne({
            where:{ email: ctx.req.body.email },
            include: {
                relation: 'company'
            }
        }, function(err, user){
            if (err) return next(err);
            if (!user) return next({statusCode: 404, message: 'Usuario inexistente.'});
            if (user.role_id === Constants.Eusers.roles.Admin) return next();
            if(user.company().status === Constants.Companies.status.Bloqueada) return next({statusCode: 403, message: 'Lo sentimos tu empresa está bloqueada, por favor contacta a soporte'});
            // TODO: bloq user if registration free time is done
            new Promise((resolve, reject) => {
                if (!("free_trial" in user))
                    return resolve();
                if (user.free_trial !== true) {
                    return resolve();
                }
                Euser.trialDaysLeft(String(user.id), (err, daysLeft) => {
                    if(err) return reject(err);
                    if(daysLeft < 0) {
                        return reject({statusCode: 403, message: 'Tu periodo de prueba se ha agotado'});
                    }
                    return resolve();
                })
            })
            .then(() => {
                return next();    
            })
            .catch(err => {
                return next(err);
            })
        });
    });

    Euser.afterRemote('login', function (ctx, modelInstance, next) {
        var id = ctx.result.userId;
        Euser.findById(id, function (err, res) {
            if (res) {
                res.lastLogin = new Date;
                res.save(function (err, user) {
                    if (err) next();
                });
            }
        });
        next();
    });

    Euser.resetPassword = function resetPassword(userId, cb) {
        Euser.findById(userId, (err, user) => {
            if (err) return cb(err);
            if (!user) return cb({ status: 400, message: 'No user found' });
            user.updateAttribute('password','Password123', (err, user) => {
                if (err) return cb(err);
                cb(null, 'OK');
            });
        });
    }

    Euser.remoteMethod(
        'resetPassword', {
            accepts: [
                { arg: 'userId', type: 'string' }
            ],
            returns: { arg: 'result', type: 'string' }
        }
    );
};
