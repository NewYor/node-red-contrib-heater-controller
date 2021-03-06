'use strict';
function backEndNode(node, config) {
    if (!config || !config.hasOwnProperty("group")) {
        throw 'heater_controller.error.no-group';
    }
    this.node = node;
    this.allowedTopics = ['currentTemp', 'userTargetValue'];
    this.config = config;
}
function override(target, source) {
    return Object.assign(target, source);
}

/**
 * Returns an scheduled event from calendar
 * @param {Calendar} calendar the calendar configuration
 * @param {int} offset a negative or positive offset, if is -1 will return the value of the previouse sechedule event if is +1 will return the next schedule event
 */
function getScheduleTemp(calendar, offset) {
    var timeNow = ("0" + new Date().getHours()).slice(-2) + ":" + ("0" + new Date().getMinutes()).slice(-2);
    var weekDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    var weekDay = weekDays[new Date().getDay()];
    var calDay = calendar[weekDay];
    var times = Object.keys(calDay);
    if (!calDay[timeNow]) {
        times.push(timeNow);
        times.sort();
        if (!offset) {
            offset = -1;
        }
    }
    var index = times.indexOf(timeNow) + (offset || 0);
    var ret = {
        temp: calDay[times[index]],
        day: weekDay,
        time: times[index],
    };
    return ret;
};

/**
 * Decides if we should turn on or off the heater;
 * @param {currentSettings} status current information about stauts of controller
 * @param {trashhold} threshold Trashsold to be able to calculate the new status of heater
 */
function recalculateAndTrigger(status, config, node) {
    var currentSchedule = getScheduleTemp(config.calendar);
    var lastSchedule = status.currentSchedule;
    var changedSchedule = !lastSchedule || currentSchedule.temp !== lastSchedule.temp || currentSchedule.day !== lastSchedule.day || currentSchedule.time !== lastSchedule.time;
    if ((changedSchedule && status.isUserCustom && !status.isUserCustomLocked) ||
        !status.isUserCustom) {
        status.targetValue = currentSchedule.temp;
        status.isUserCustom = false;
    } else if (status.isUserCustom) {
        status.targetValue = status.userTargetValue;
    } else if (!status.targetValue) {
        status.targetValue = status.currentSchedule.temp;
        status.isUserCustom = false;
    } else {
        node.error('Invalid state: target temperature and customer locking is active');
        return undefined;
    }

    if (status.targetValue === undefined || status.currentTemp === undefined) {
        node.error('Missing: ' + (status.currentTemp === undefined ? 'currentTemp ' : ' ') + (status.targetValue === undefined ? 'targetValue' : ''));
        return undefined;
    }
    status.currentSchedule = currentSchedule;
    status.nextSchedule = getScheduleTemp(config.calendar, 1);

    var difference = (status.targetValue - status.currentTemp);
    var newHeaterStatus = (difference < 0 ? "off" : "on");
    var threshold = (newHeaterStatus === "off" ? config.thresholdRising : config.thresholdFalling);
    var changeStatus = (Math.abs(difference) >= threshold);
    if (changeStatus) {
        status.currentHeaterStatus = newHeaterStatus;
    }
    return status;
};

backEndNode.prototype.getAdaptedConfig = function () {
    this.config.calendar = JSON.parse(this.config.calendar);
    return this.config;
}
backEndNode.prototype.getWidget = function () {
    var frontEnd = require('./frontEnd').init(this.config);
    var html = frontEnd.getHTML();
    var me = this;
    return {
        format: html,
        templateScope: "local",
        emitOnlyNewValues: false,
        forwardInputMessages: false,
        storeFrontEndInputAsState: true,
        initController: frontEnd.getController,
        beforeEmit: function () { return me.beforeEmit.apply(me, arguments); },
        beforeSend: function () { return me.beforeSend.apply(me, arguments); }
    };
}

backEndNode.prototype.beforeEmit = function (msg, value) {
    var context = this.node.context();
    var existingValues = context.get("values") || {};
    if (this.allowedTopics.indexOf(msg.topic) < 0) { //if topic is not a safe one just trigger a refresh of UI
        return { msg: existingValues }; //return what I already have
    }
    //in case we need more topics we have to see if we should convert value 
    value = parseFloat(value);
    var returnValues = override(existingValues, { [msg.topic]: value });
    context.set("values", returnValues);
    switch (msg.topic) {
        case 'userTargetValue':
            returnValues.isUserCustom = true;
            /* No break, continue with updating values... */
        case 'currentTemp':
            returnValues = recalculateAndTrigger(returnValues, this.config, this.node);
            context.set("values", returnValues);

            this.node.send({
                topic: this.config.topic,
                payload: returnValues
            });
            break;
    }
    return { msg: returnValues };
};

backEndNode.prototype.beforeSend = function (msg, orig) {
    if (orig) {
        var result = recalculateAndTrigger(orig.msg, this.config, this.node);
        if (result) {
            var newValues = override(this.node.context().get("values") || {}, result); //merge user changes and store them in context
            this.node.context().set("values", newValues); //Store in conetext
            return {
                payload: newValues,
                topic: this.config.topic
            };
        } else {
            return undefined;
        }
    }
};

module.exports = backEndNode;