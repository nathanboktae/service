var async = require("async")
  , config = require('../config')
  , crypto = require("crypto")
  , log = require('../log')
  , models = require("../models")
  , services = require("../services");

var authenticate = function(authBody, callback) {
    if (authBody.email && authBody.password) {
        authenticateUser(authBody.email, authBody.password, callback);
    } else if (authBody.id && authBody.secret) {
        authenticateDevice(authBody.id, authBody.secret, callback);
    } else {
        callback("Please sign in with your email and password.");
    }
};

var authenticateUser = function(email, password, callback) {
    findByEmail(services.principals.systemPrincipal, email, function(err, principal) {
        if (err) return callback(err);
        if (!principal) return callback("The email or password you entered were not accepted.  Please try again.");

        log.info("found user email: " + email + " verifying password.");
        verifyPassword(password, principal, function(err) {
            if (err) return callback(err);

            log.info("verified password, creating access token.");
            services.accessTokens.findOrCreateToken(principal, function(err, accessToken) {
                if (err) return callback(err);

                log.info("authenticated user principal: " + principal.id);
                callback(null, principal, accessToken);
            });
        });
    });
};

var authenticateDevice = function(principalId, secret, callback) {
    findById(services.principals.systemPrincipal, principalId, function(err, principal) {
        if (err) return callback(err);
        if (!principal) return callback("The secret provided was not accepted.  Please try again.");

        verifySecret(secret, principal, function(err) {
            if (err) return callback(err);

            services.accessTokens.findOrCreateToken(principal, function(err, accessToken) {
                if (err) return callback(err);

                log.info("authenticated device principal: " + principal.id);
                callback(null, principal, accessToken);
            });
        });
    });
};

var create = function(principal, callback) {
    validate(principal, function(err) {
        if (err) return callback(err);

        checkForExistingPrincipal(principal, function(err, foundPrincipal) {
            if (err) return callback(err);
            if (foundPrincipal) return callback("A user with that email already exists.  Please sign in with your email and password.");

            createCredentials(principal, function(err, principal) {
                if (err) return callback(err);

                principal.save(function(err, principal) {
                    if (err) return callback(err);

                    log.info("created " + principal.principal_type + " principal: " + principal.id);
                    callback(null, principal);
                });
            });
        });
    });
};

var checkForExistingPrincipal = function(principal, callback) {
    if (!services.principals.systemPrincipal) return callback(null, null);

    if (principal.isUser()) {
        findByEmail(services.principals.systemPrincipal, principal.email, callback);
    } else {
        findById(services.principals.systemPrincipal, principal.id, callback);
    }
};

var createCredentials = function(principal, callback) {
    if (principal.isUser()) {
        createUserCredentials(principal, callback);
    } else {
        createSecretCredentials(principal, callback);
    }
};

var createSecretCredentials = function(principal, callback) {
    if (!config.device_secret_bytes) return callback("Service is misconfigured.  Please add value for missing device_secret_bytes element.");

    crypto.randomBytes(config.device_secret_bytes, function(err, secretBuf) {
        if (err) return callback(err, null);

        principal.secret = secretBuf.toString('base64');

        hashSecret(principal.secret, function(err, hashedSecret) {
            if (err) return callback(err, null);

            principal.secret_hash = hashedSecret;
            callback(null, principal);
        });
    });
};

var createUserCredentials = function(principal, callback) {
    crypto.randomBytes(config.salt_length_bytes, function(err, saltBuf) {
        hashPassword(principal.password, saltBuf, function(err, hashedPasswordBuf) {
            if (err) return callback(err, null);

            principal.salt = saltBuf.toString('base64');
            principal.password_hash = hashedPasswordBuf.toString('base64');
            callback(null, principal);
        });
    });
};

var filterForPrincipal = function(principal, filter) {
    if (principal && principal.isSystem()) return filter;

    var visibilityFilter = [ { public: true }];
    if (principal) {
        visibilityFilter.push( { owner: principal._id } );
        visibilityFilter.push( { "_id": principal._id } );
    }

    filter["$or"] = visibilityFilter;
    return filter;

};

var find = function(principal, filter, options, callback) {
    models.Principal.find(filterForPrincipal(principal, filter), null, options, callback);
};

var findByEmail = function(principal, email, callback) {
    models.Principal.findOne(filterForPrincipal(principal, { "email": email }), callback);
};

var findById = function(principal, id, callback) {
    models.Principal.findOne(filterForPrincipal(principal, { "_id": id }), callback);
};

var hashPassword = function(password, saltBuf, callback) {
    crypto.pbkdf2(password, saltBuf,
        config.password_hash_iterations, config.password_hash_length,
        function(err, hash) {
            if (err) return callback(err, null);

            var hashBuf = new Buffer(hash, 'binary');
            callback(null, hashBuf);
        });
};


var hashSecret = function(secret, callback) {
    // have to create a buffer here because node's sha256 hash function expects binary encoding.
    var secretBuf = new Buffer(secret, 'base64');

    var sha256 = crypto.createHash('sha256');
    sha256.update(secretBuf.toString('binary'), 'binary');

    callback(null, sha256.digest('base64'));
};

var impersonate = function(principal, impersonatedPrincipalId, callback) {
    if (principal.principal_type != "system" && principal.id != impersonatedPrincipalId) return callback(401);

    findById(services.principals.systemPrincipal, impersonatedPrincipalId, function(err, impersonatedPrincipal) {
        if (err) return callback(err);
        if (!impersonatedPrincipal) return callback(401);

        services.accessTokens.findOrCreateToken(impersonatedPrincipal, function(err, accessToken) {
            if (err) return callback(err);

            log.info("impersonated device principal: " + impersonatedPrincipal.id);
            callback(null, impersonatedPrincipal, accessToken);
        });
    });
};

var initialize = function(callback) {

    // we don't use services find() here because it is a chicken and an egg visibility problem.
    // we aren't system so we can't find system. :)

    models.Principal.find({ principal_type: "system" }, null, {}, function(err, principals) {
        if (err) return callback(err);

        log.info("found " + principals.length + " system principals");

        if (principals.length == 0) {
            log.info("creating system principal");
            var systemPrincipal = new models.Principal({ principal_type: "system" });
            create(systemPrincipal, function(err, systemPrincipal) {
                if (err) return callback(err);

                services.principals.systemPrincipal = systemPrincipal;
                return callback(err);
            });
        } else {
            services.principals.systemPrincipal = principals[0];
            return callback();
        }
    });
};

var update = function(authorizingPrincipal, id, updates, callback) {
    if (!authorizingPrincipal || !authorizingPrincipal.isSystem()) {
        updates = { name: updates.name };
    }

    models.Principal.update({ _id: id }, { $set: updates }, function (err, updateCount) {
        if (err) return callback(err);

        findById(authorizingPrincipal, id, callback);
    });
};

var updateLastConnection = function(principal, ip) {

    var updates = {}
    // emit a ip message each time ip changes for principal.
    if (principal.last_ip != ip) {
        principal.last_ip = updates.last_ip = ip;

        var ipMessage = new models.Message({ "message_type": "ip" });
        ipMessage.from = principal;
        ipMessage.to = services.principals.systemPrincipal.id;
        ipMessage.body.ip_address = ip;

        services.messages.create(ipMessage, function(err, message) {
            if (err) log.info("creating ip message failed: " + err);
        });
    }

    principal.last_connection = updates.last_connection = new Date();

    services.principals.update(services.principals.systemPrincipal, principal.id, updates, function(err, principal) {
        if (err) return log.error("updating last connection failed: " + err);
    });
};

var validate = function(principal, callback) {
    if (principal.principal_type !== "device" && principal.principal_type !== "user" && principal.principal_type !== "system")
        return callback("Principal type must be one of device, user, or system.");

    if (principal.isUser()) {
        if (!principal.email) return callback("user principal must have email");
        if (!principal.password) return callback("user principal must have password");        
    }

    callback(null);
};

var verifyPassword = function(password, user, callback) {
    var saltBuf = new Buffer(user.salt, 'base64');

    hashPassword(password, saltBuf, function(err, hashedPasswordBuf) {
        if (err) return callback(err);
        log.info("hashed password: " + hashedPasswordBuf.toString('base64'));
        if (user.password_hash != hashedPasswordBuf.toString('base64')) return callback(401);

        callback(null);
    });
};

var verifySecret = function(secret, principal, callback) {
    hashSecret(secret, function(err, hashedSecret) {
        if (err) return callback(err);
        if (hashedSecret != principal.secret_hash) {
            log.info("verification of secret for principal: " + principal.id + " failed");
            return callback(401);
        }

        callback(null);
    });
};

module.exports = {
    authenticate: authenticate,
    create: create,
    find: find,
    findById: findById,
    impersonate: impersonate,
    initialize: initialize,
    update: update,
    updateLastConnection: updateLastConnection,
    verifySecret: verifySecret,
    verifyPassword: verifyPassword,

    systemPrincipal: null
};
