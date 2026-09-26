// Tiny typed event bus. Every subsystem talks through this and nothing else.
export const bus = (() => {
  const handlers = new Map();
  const log = [];
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    emit(type, payload) {
      if (type !== "GAZE") {                       // GAZE is 25Hz, don't log it
        log.push({ t: performance.now(), type, payload });
        if (log.length > 400) log.shift();
      }
      const hs = handlers.get(type);
      if (hs) for (const fn of hs) {
        try { fn(payload); } catch (e) { console.error(`[bus:${type}]`, e); }
      }
    },
    dump: () => log,
  };
})();
