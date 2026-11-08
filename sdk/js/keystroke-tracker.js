(function () {
  // opts.skip(field) -> true: that field leaves no event at all (the organisation's "fields never
  // watched"; the SDK passes its own check). Fields are inputs, textareas and rich-text editors
  // (contenteditable; the outermost editable element is the field).
  function createTracker(form, opts) {
    let events = [];
    let startTime = 0;
    const skip = opts && typeof opts.skip === "function" ? opts.skip : null;

    function fieldOf(t) {
      if (!t || t.nodeType !== 1) return null;
      if (t.matches("input, textarea")) return t;
      if (!t.isContentEditable) return null;
      let root = t;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }
    function typeOf(f) {
      return f.matches("input, textarea") ? (f.type || f.tagName.toLowerCase()) : "contenteditable";
    }

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
      const f = fieldOf(evt.target);
      if (!f || (skip && skip(f))) return;
      // A held key's auto-repeat and IME composition are not the person's keystrokes (2026-11-08): a held arrow key
      // fires a keydown every ~30 ms, which the server's degenerate-input rule read as erratic typing, and IMEs
      // (Android keyboards among them) report keyCode 229 for every key, which it read as one key hammered.
      if (evt.repeat || evt.isComposing || evt.keyCode === 229) return;

      events.push({
        fieldName: f.name || f.id || "field",
        fieldType: typeOf(f),
        keyCode: f.type === "password" ? 0 : evt.keyCode,
        eventType: evt.type,
        timestampRelative: relativeTime(evt),
      });
    }

    function trackPaste(evt) {
      const f = fieldOf(evt.target);
      if (!f || (skip && skip(f))) return;

      events.push({
        fieldName: f.name || f.id || "field",
        fieldType: typeOf(f),
        keyCode: 0,
        eventType: "paste",
        timestampRelative: relativeTime(evt),
        pastedLength: evt.clipboardData ? evt.clipboardData.getData("text").length : 0,
      });
    }

    // Text dropped into a field is recorded as a paste (2026-11-08): it is inserted, not typed, and dragging it in
    // used to get past the organisation's paste allowance. Autofill, dictation and spelling suggestions
    // (beforeinput insertReplacementText) are not counted: they insert what the user chose or said, and an allowance
    // would then lock people who dictate or accept a correction.
    function trackDrop(evt) {
      const f = fieldOf(evt.target);
      if (!f || (skip && skip(f))) return;
      const text = evt.dataTransfer ? evt.dataTransfer.getData("text") : "";
      if (!text) return;
      events.push({
        fieldName: f.name || f.id || "field",
        fieldType: typeOf(f),
        keyCode: 0,
        eventType: "paste",
        timestampRelative: relativeTime(evt),
        pastedLength: text.length,
      });
    }

    form.addEventListener("focusin", ensureStartTime);
    form.addEventListener("keydown", track);
    form.addEventListener("keyup", track);
    form.addEventListener("paste", trackPaste);
    form.addEventListener("drop", trackDrop);

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
