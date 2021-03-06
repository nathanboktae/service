var async = require('async')
  , config = require('../config')
  , crypto = require('crypto')
  , log = require('../log')
  , models = require('../models')
  , moment = require('moment')
  , mongoose = require('mongoose')
  , services = require('../services')
  , utils = require('../utils');

var cacheKeyToken = function(token) {
    return "token." + token;
};

var clearTokenCacheEntry = function(token, callback) {
    var cacheKey = cacheKeyToken(token);
    log.debug('accessTokens: clearing cache entry ' + cacheKey);

    config.cache_provider.del('accessTokens', cacheKey, callback);
};

var create = function(principal, callback) {
    log.debug('accesstokens: creating accesstoken for principal: ' + principal.id);

    var accessToken = new models.AccessToken({
        expires_at: moment().add('days', config.access_token_lifetime).toDate(),
        principal: principal
    });

    crypto.randomBytes(config.access_token_bytes, function(err, tokenBuf) {
        if (err) return callback(err);

        accessToken.token = tokenBuf.toString('base64');
        accessToken.save(callback);
    });
};

var find = function(query, options, callback) {
    models.AccessToken.find(query, null, options, callback);
};

var findByPrincipal = function(principal, callback) {
    find({ principal: principal.id }, { sort: { expires_at: -1 } }, callback);
};

var findByTokenCached = function(token, callback) {
    var cacheKey = cacheKeyToken(token);

    config.cache_provider.get('accessTokens', cacheKey, function(err, accessTokenObj) {
        if (err) return callback(err);
        if (accessTokenObj) {
            log.debug("accessTokens: " + cacheKey + ": cache hit");
            var accessToken = new models.AccessToken(accessTokenObj);

            // Mongoose by default will override the passed id with a new unique one.  Set it back.
            accessToken._id = mongoose.Types.ObjectId(accessTokenObj.id);

            return callback(null, accessToken);
        }

        log.debug("accessTokens: " + cacheKey + ": cache miss.");

        // find and cache result
        return findByToken(token, callback);
    });
};

var findByToken = function(token, callback) {
    models.AccessToken.findOne({
        token: token
    }, function(err, accessToken) {
        if (err) return callback(err);
        if (!accessToken) return callback(null, undefined);

        var cacheKey = cacheKeyToken(token);

        log.debug("accessTokens: setting cache entry for " + cacheKey);
        config.cache_provider.set('accessTokens', cacheKey, accessToken, accessToken.expires_at, function(err) {
            return callback(err, accessToken);
        });

    });
};

var findOrCreateToken = function(principal, callback) {
    findByPrincipal(principal, function(err, tokens) {
        if (err) return callback(err);

        if (tokens && tokens.length > 0) {
            log.debug('accesstokens: found existing accesstoken for principal: ' + JSON.stringify(tokens[0]));
        }

        if (tokens && tokens.length > 0 && !isCloseToExpiration(tokens[0])) {
            return callback(null, tokens[0]);
        } else {
            create(principal, function(err, accessToken) {
                if (err) return callback(err);

                callback(null, accessToken);
            });
        }
    });
};

// an access token is close to expiration if less than 10% of its original life exists.
var isCloseToExpiration = function(accessToken) {
    return accessToken.secondsToExpiration() < config.refresh_token_threshold * config.access_token_lifetime * 24 * 60 * 60;
};

var remove = function(query, callback) {
    find(query, {}, function(err, accessTokens) {
        if (err) return callback(err);

        // remove all matches from cache before removal
        async.eachLimit(accessTokens, 20, function(accessToken, cb) {
            clearTokenCacheEntry(accessToken.token, cb);
        }, function(err) {
            if (err) return callback(err);

            models.AccessToken.remove(query, callback);
        });
    });
};

var removeByPrincipal = function(principal, callback) {
    remove({ principal: principal._id }, callback);
};

var verify = function(token, done) {
    findByTokenCached(token, function(err, accessToken) {
        if (err) return done(err);

        if (!accessToken) {
            var msg = "Access token " + token + " not found.";
            log.error(msg);
            return done(msg, false);
        }

        if (accessToken.expired()) {
            var msg = "Access token has expired.";
            log.error(msg);
            return done(msg, false);
        }

        services.principals.findByIdCached(services.principals.servicePrincipal, accessToken.principal, function(err, principal) {
            if (err) return done(err);
            if (!principal) {
                var msg = "AccessToken service.verify: principal for accessToken " + accessToken.id + " not found.";
                log.error(msg);
                return done(new Error(msg));
            }

            principal.accessToken = accessToken;
            done(null, principal);
        });
    });
};

module.exports = {
    create: create,
    findByPrincipal: findByPrincipal,
    findByToken: findByToken,
    findByTokenCached: findByTokenCached,
    findOrCreateToken: findOrCreateToken,
    isCloseToExpiration: isCloseToExpiration,
    remove: remove,
    removeByPrincipal: removeByPrincipal,
    verify: verify
};
