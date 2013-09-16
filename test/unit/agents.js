var assert = require('assert')
  , config = require('../../config')
  , fixtures = require('../fixtures')
  , models = require('../../models')
  , services = require('../../services');

describe('agent service', function() {

    it('matcher automatically matches case where 1 user and 1 device are at same ip', function(done) {

        services.principals.updateLastConnection(fixtures.models.principals.user, "127.0.0.1");

        setTimeout(function() {
            services.principals.findById(services.principals.servicePrincipal, fixtures.models.principals.device.id, function(err, principal) {
                assert.ifError(err);
                assert.equal(principal.owner, fixtures.models.principals.user.id);
                done();
            });
        }, 200);

    });

    it('matcher does not match 2 users at same ip address for 2nd user', function(done) {
        services.principals.update(services.principals.servicePrincipal, fixtures.models.principals.device.id, { owner: null }, function(err, principal) {
            assert.equal(principal.owner, null);

            services.principals.updateLastConnection(fixtures.models.principals.user, "127.0.0.1");
            services.principals.updateLastConnection(fixtures.models.principals.anotherUser, "127.0.0.1");

            setTimeout(function() {
                services.principals.findById(services.principals.servicePrincipal, fixtures.models.principals.device.id, function(err, principal) {
                    assert.ifError(err);
                    assert.equal(principal.owner, null);
                    done();
                });
            }, 200);
        });
    });

    it('claim agent can claim devices', function(done) {
        services.principals.update(services.principals.servicePrincipal, fixtures.models.principals.device.id, { owner: null, claim_code: 'TAKE-1234' }, function(err, principal) {
            assert.equal(principal.owner, null);
            assert.equal(principal.claim_code, 'TAKE-1234');

            var claim = new models.Message({
                type: 'claim',
                from: fixtures.models.principals.user.id,
                body: {
                    claim_code: 'TAKE-1234'
                }
            });

            services.messages.create(claim, function(err, message) {
                setTimeout(function() {
                    services.principals.findById(services.principals.servicePrincipal, fixtures.models.principals.device.id, function(err, principal) {
                        assert.ifError(err);
                        assert.equal(principal.owner, fixtures.models.principals.user.id);
                        done();
                    });
                }, 200);                
            });
        });
    });

});
