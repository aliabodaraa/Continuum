(function () {
  function createTracker(form) {
    let events = [];
    let startTime = 0;

    // Timestamps use evt.timeStamp — the moment the browser CREATED the input
    // event (high-resolution, monotonic) — NOT Date.now() at handler run time.
    // Under main-thread jank (e.g. a heavy render frame) several key events
    // queue up and their handlers all run in the same millisecond; stamping
    // them with Date.now() produced impossible timings (dd = 0 ms, dwell =
    // 10 ms) that crashed genuine windows as out-of-distribution. evt.timeStamp
    // preserves the true hardware timing regardless of when the handler runs.
    function relativeTime(evt) {
      if (!startTime) startTime = evt.timeStamp;
      return Math.round(evt.timeStamp - startTime);
    }

    function ensureStartTime(evt) {
      if (!startTime && evt && typeof evt.timeStamp === "number") {
        startTime = evt.timeStamp;
      }
    }

    function track(evt) {
      if (!evt.target.matches("input, textarea")) return;

      events.push({
        fieldName: evt.target.name || evt.target.id || "field",
        fieldType: evt.target.type || evt.target.tagName.toLowerCase(),
        keyCode: evt.target.type === "password" ? 0 : evt.keyCode,
        eventType: evt.type,
        timestampRelative: relativeTime(evt),
      });
    }

    function trackPaste(evt) {
      if (!evt.target.matches("input, textarea")) return;

      events.push({
        fieldName: evt.target.name || evt.target.id || "field",
        fieldType: evt.target.type || evt.target.tagName.toLowerCase(),
        keyCode: 0,
        eventType: "paste",
        timestampRelative: relativeTime(evt),
        pastedLength: evt.clipboardData ? evt.clipboardData.getData("text").length : 0,
      });
    }

    form.addEventListener("focusin", ensureStartTime);
    form.addEventListener("keydown", track);
    form.addEventListener("keyup", track);
    form.addEventListener("paste", trackPaste);

    return {
      getEvents() {
        return events.slice();
      },
      reset() {
        events = [];
        startTime = 0;
      },
    };
  }

  function analyze(events) {
    const dwellTimes = [];
    const flightTimes = [];
    const lastDownByFieldAndKey = {};
    let previousKeyUp = null;
    let keyCount = 0;
    let pasteCount = 0;
    let pastedLength = 0;

    events.forEach((evt) => {
      if (evt.eventType === "paste") {
        pasteCount += 1;
        pastedLength += Number(evt.pastedLength || 0);
        return;
      }

      const keyId = `${evt.fieldName}:${evt.keyCode}`;
      if (evt.eventType === "keydown") {
        keyCount += 1;
        if (previousKeyUp) {
          const flight = evt.timestampRelative - previousKeyUp.timestampRelative;
          if (flight >= 0 && flight < 10000) flightTimes.push(flight);
        }
        lastDownByFieldAndKey[keyId] = evt;
        return;
      }

      const down = lastDownByFieldAndKey[keyId];
      if (down) {
        const dwell = evt.timestampRelative - down.timestampRelative;
        if (dwell >= 0 && dwell < 5000) dwellTimes.push(dwell);
        delete lastDownByFieldAndKey[keyId];
      }
      previousKeyUp = evt;
    });

    const avg = (arr) =>
      arr.length > 0 ? arr.reduce((total, value) => total + value, 0) / arr.length : 0;
    const durationMs =
      events.length > 1
        ? events[events.length - 1].timestampRelative - events[0].timestampRelative
        : 0;

    return {
      avgDwellTime: avg(dwellTimes),
      avgFlightTime: avg(flightTimes),
      maxFlightTime: flightTimes.length > 0 ? Math.max.apply(null, flightTimes) : 0,
      totalDwellTime: dwellTimes.reduce((total, value) => total + value, 0),
      totalFlightTime: flightTimes.reduce((total, value) => total + value, 0),
      eventCount: events.length,
      keyCount,
      pasteCount,
      pastedLength,
      durationMs,
    };
  }

  window.continuumKeystrokes = {
    createTracker,
    analyze,
  };
})();
