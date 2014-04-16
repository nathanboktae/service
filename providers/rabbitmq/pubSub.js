var assert = require('assert')
  , async = require('async')
  , amqp = require('amqp')
  , log = require('../../log')
  , sift = require('sift')
  , utils = require ('../../utils');

function RabbitMQPubSubProvider(config) {

    if (!process.env.RABBITMQ_URL) {
        return log.warn("RabbitMQPubSubProvider: Server not configured.  Set RABBITMQ_SERVER as environment variables to configure the RabbitMQ pub sub provider.");
    }

    var self = this;

    this.connection = amqp.createConnection({ url: process.env.RABBITMQ_URL });
    this.connection.on('ready', function() {
        self.connection.exchange(RabbitMQPubSubProvider.EXCHANGE_NAME, { type: 'direct', durable: true, autoDelete: false }, function(exchange) {
            self.exchange = exchange;
        });
    })

    this.SUPPORTS_PERMANENT_SUBSCRIPTIONS = true;

    // for test only
    this.subscriptions = {};
}

RabbitMQPubSubProvider.RECEIVE_TIMEOUT_SECONDS = 5 * 60;
RabbitMQPubSubProvider.EXCHANGE_NAME = 'nitrogen';
RabbitMQPubSubProvider.prototype.MAX_LATENCY = 200;

RabbitMQPubSubProvider.buildQueueName = function(type, id) {
    return type + "." + id;
};

RabbitMQPubSubProvider.prototype.createSubscription = function(subscription, callback) {
    var self = this;
    log.debug('RabbitMQPubSubProvider:creating subscription for type: ' + subscription.type + ' with id: ' + subscription.id + ' with filter: ' + JSON.stringify(subscription.filter));

    var queueName = RabbitMQPubSubProvider.buildQueueName(subscription.type, subscription.id);

    if (process.env.NODE_ENV !== "production") this.subscriptions[queueName] = subscription;

    this.connection.queue(queueName, { durable: true, autoDelete: false }, function(queue) {
        queue.bind(self.exchange, queueName);

        return callback(null, subscription);
    });
};

RabbitMQPubSubProvider.prototype.publish = function(type, item, callback) {
    var self = this;
    log.debug("RabbitMQPubSubProvider: publishing " + type + ": " + item.id + ": " + JSON.stringify(item));

    // for each principal this message is visible_to
    async.each(item.visible_to, function(visibleToId, visibleToCallback) {

        // query the subscriptions that principal has
        self.services.subscriptions.find(self.services.principals.servicePrincipal, { principal: visibleToId }, {}, function(err, subscriptions) {
            if (err) return visibleToCallback(err);

            //log.debug('subscriptions: ' + JSON.stringify(subscriptions));

            async.each(subscriptions, function(subscription, subscriptionCallback) {
                log.debug("RabbitMQPubSubProvider: CHECKING subscription: name: " + subscription.name + " type: " + subscription.type + " filter: " + JSON.stringify(subscription.filter));

                if (subscription.type !== type) return subscriptionCallback();

                var unfilteredItems = sift(subscription.filter, [item]);

                if (unfilteredItems.length === 0) return subscriptionCallback();

                log.debug("RabbitMQPubSubProvider: MATCHED subscription: id: " + subscription.id + " type: " + subscription.type + " filter: " + JSON.stringify(subscription.filter));
                log.debug("RabbitMQPubSubProvider: MATCHED message: " + JSON.stringify(item));

                var queueName = RabbitMQPubSubProvider.buildQueueName(subscription.type, subscription.id);
                self.exchange.publish(queueName, JSON.stringify(item), { deliveryMode: 2 });

                return subscriptionCallback();
            }, visibleToCallback);
        });
    }, callback);
};

RabbitMQPubSubProvider.prototype.receive = function(subscription, callback) {
    if (!subscription.type) return callback(new Error('Subscription type required.'));
    if (!subscription.id) return callback(new Error('Subscription id required.'));

    var queueName = RabbitMQPubSubProvider.buildQueueName(subscription.type, subscription.id);
    var self = this;

    this.connection.queue(queueName, { durable: true, autoDelete: false, closeChannelOnUnsubscribe: true }, function(queue) {
        var ctag;

        // TODO: reimplement with persistent subscriptions?
        queue.subscribe({ ack: true, prefetchCount: 1 }, function (message) {
            var itemJson = unescape(message.data);

            log.debug("RabbitMQPubSubProvider: RECEIVED ON subscription: id: " + subscription.id + " :" + itemJson);
            var item = JSON.parse(itemJson);

            queue.unsubscribe(ctag);
            queue.shift();
            return callback(null, item);
        }).addCallback(function(ok) {
            ctag = ok.consumerTag;
        });
    });
};

RabbitMQPubSubProvider.prototype.removeSubscription = function(subscription, callback) {
    var queueName = RabbitMQPubSubProvider.buildQueueName(subscription.type, subscription.id);

    if (process.env.NODE_ENV !== "production") delete this.subscriptions[queueName];

    this.connection.queue(queueName, { durable: true, autoDelete: false }, function(queue) {
        queue.destroy();

        return callback();
    });
};

RabbitMQPubSubProvider.prototype.staleSubscriptionCutoff = function() {
    return new Date(new Date().getTime() + -4 * 1000 * RabbitMQPubSubProvider.RECEIVE_TIMEOUT_SECONDS);
};

// TEST ONLY METHODS BELOW

RabbitMQPubSubProvider.prototype.resetForTest = function(callback) {
    if (process.env.NODE_ENV === "production") return callback();

    log.debug('RabbitMQPubSubProvider: resetting queues completely for test');

    this.subscriptions = {};

    return callback();
};

RabbitMQPubSubProvider.prototype.subscriptionsForServer = function(serverId, callback) {
    var self = this;
    var subscriptions = Object.keys(this.subscriptions).map(function(key) {
        return self.subscriptions[key];
    });

    return callback(null, subscriptions);
};

module.exports = RabbitMQPubSubProvider;