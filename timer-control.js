/* Original-page control only. This module never reads browser profile databases. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StudyTimerControl = api;
}(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const CLIENTS = new Set(["ipad", "iphone", "mac", "mouse"]);
  const ACTIONS = new Set(["start", "resume", "pause", "distraction", "prepare_stop", "cancel_stop", "stop"]);
  const REASONS = Object.freeze({
    personal_bathroom: "上厕所", hydration: "装水", private_break: "打飞机",
    social_media_break: "看 Twitter 休息", video_break: "看 B 站休息",
    messaging_break: "看微信休息", short_video_break: "看微信视频号休息",
    family_conversation: "跟家人聊天休息", misc_tasks: "处理杂七杂八的事情休息",
    mind_wandering: "发呆休息"
  });
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const CONFIRMATION_MS = 30000;
  const RECEIPT_LIMIT = 32;

  function result(error, extra = {}) { return { ok: !error, ...(error ? { error } : {}), ...extra }; }
  function statusOf(state) {
    if (state.pendingCompletion) return "pending_completion";
    if (!state.active) return "idle";
    if (state.active.pendingPauseChoice) return "pause_reason_pending";
    if (state.active.currentVocabulary) return "vocabulary";
    if (state.active.currentPause) return "paused";
    return "running";
  }
  function snapshot(state, task, writer = true) {
    const active = state.active;
    return {
      source: "original_html", status: statusOf(state), writer: writer === true,
      blockId: active && active.blockId || null,
      revision: Number(state.guardianRevision || 0),
      task: String(active ? active.task || "" : task || "").slice(0, 240),
      kind: active ? active.kind || "study" : state.lastKind || "study",
      timerMode: active ? active.timerMode || "countup" : state.lastTimerMode || "countup",
      pauseReason: active && active.currentPause ? active.currentPause.reasonCode || "preset_other" : null
    };
  }
  function validate(command, now) {
    if (!command || typeof command !== "object" || Array.isArray(command)) return "invalid_command";
    const keys = new Set(["action", "client", "requestId", "expected", "reason", "confirmation", "expiresAt", "transportEpoch"]);
    if (Object.keys(command).some((key) => !keys.has(key))) return "unknown_parameter";
    if (!ACTIONS.has(command.action) || !CLIENTS.has(command.client) || !ID.test(command.requestId || "")) return "invalid_command";
    if (!Number.isSafeInteger(command.expiresAt) || command.expiresAt < now || command.expiresAt > now + 15000) return "expired_command";
    if (!ID.test(command.transportEpoch || "")) return "invalid_transport_epoch";
    const expected = command.expected;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)
      || Object.keys(expected).some((key) => !["blockId", "revision", "status"].includes(key))
      || !Number.isSafeInteger(expected.revision) || expected.revision < 0
      || !(expected.blockId === null || ID.test(expected.blockId || ""))
      || typeof expected.status !== "string") return "invalid_expected_state";
    if (command.action === "pause") {
      if (!Object.hasOwn(REASONS, command.reason || "")) return "invalid_reason";
    } else if (command.reason !== undefined) return "unexpected_reason";
    if (["stop", "cancel_stop"].includes(command.action)) {
      if (!ID.test(command.confirmation || "")) return "invalid_confirmation";
    } else if (command.confirmation !== undefined) return "unexpected_confirmation";
    return null;
  }
  function fingerprint(command) {
    return JSON.stringify([command.client, command.action, command.expected.blockId,
      command.expected.revision, command.expected.status, command.reason || null,
      command.confirmation || null, command.transportEpoch]);
  }

  function createController(adapter) {
    const now = adapter.now || Date.now;
    const randomId = adapter.randomId || (() => crypto.randomUUID());
    const confirmations = new Map();
    let transportEpoch = null;
    function current() { return adapter.snapshot(); }
    function resetConfirmations(epoch) {
      if (transportEpoch !== epoch) { confirmations.clear(); transportEpoch = epoch; }
    }
    async function dispatch(command) {
      const error = validate(command, now());
      if (error) return result(error, { state: current() });
      resetConfirmations(command.transportEpoch);
      if (!adapter.supportsAtomicWrites()) return result("atomic_writes_unavailable", { state: current() });
      let answer;
      try {
        answer = await adapter.runMutation(() => {
          const before = current();
          if (!before.writer) return result("not_original_writer");
          const key = command.client + ":" + command.requestId;
          const hash = fingerprint(command);
          const receipt = adapter.getReceipts().find((entry) => entry.key === key);
          if (receipt) return receipt.fingerprint === hash
            ? result(null, { ...receipt.result, duplicate: true }) : result("request_id_reused");
          if (command.expiresAt < now()) return result("expired_command");
          if (command.action === "cancel_stop") {
            const own = confirmations.get(command.client);
            if (own && own.id === command.confirmation) confirmations.delete(command.client);
            return result(null, { action: command.action, requestId: command.requestId, cancelled: true });
          }
          if (command.expected.blockId !== before.blockId
            || command.expected.revision !== before.revision
            || command.expected.status !== before.status) return result("state_changed");
          const operation = command.action;
          if (operation === "prepare_stop") {
            if (!["running", "paused"].includes(before.status)) return result("stop_not_available");
            const challenge = { id: randomId(), client: command.client, blockId: before.blockId,
              revision: before.revision, status: before.status, expiresAt: now() + CONFIRMATION_MS,
              epoch: transportEpoch };
            confirmations.set(command.client, challenge);
            return result(null, { action: operation, requestId: command.requestId,
              confirmation: challenge.id, expiresAt: challenge.expiresAt, awaitingConfirmation: true });
          }
          if (operation === "start") {
            if (before.status !== "idle") return result("start_not_available");
            if (!before.task.trim() || before.task.trim() === "未标注任务") return result("task_required");
          } else if (operation === "resume") {
            if (before.status !== "paused") return result("resume_not_available");
          } else if (operation === "pause") {
            if (before.status !== "running") return result("pause_not_available");
          } else if (operation === "distraction") {
            if (before.status !== "running" || before.kind !== "study") return result("distraction_not_available");
          } else if (operation === "stop") {
            const challenge = confirmations.get(command.client);
            if (!challenge || challenge.id !== command.confirmation || challenge.client !== command.client
              || challenge.epoch !== transportEpoch || challenge.expiresAt < now()
              || challenge.blockId !== before.blockId || challenge.revision !== before.revision
              || challenge.status !== before.status) return result("confirmation_expired");
            confirmations.delete(command.client);
          }
          const performed = adapter.perform(operation, {
            reason: REASONS[command.reason], reasonCode: command.reason,
            eventId: "control-" + command.client + "-" + command.requestId,
            sourceCode: "control_" + command.client
          });
          if (!performed || performed.ok !== true) return result(performed && performed.error || "action_failed");
          const after = current();
          const valid = operation === "start" ? after.status === "running" && after.blockId !== before.blockId
            : operation === "resume" ? after.status === "running" && after.blockId === before.blockId
            : operation === "pause" ? after.status === "paused" && after.blockId === before.blockId && after.pauseReason === command.reason
            : operation === "distraction" ? after.status === "running" && after.blockId === before.blockId
            : ["idle", "pending_completion"].includes(after.status) && after.blockId === null;
          if (!valid) return result("action_incomplete", { partial: true });
          const completed = { action: operation, requestId: command.requestId, completed: true,
            ...(after.status === "pending_completion" ? { awaitingReview: true } : {}) };
          adapter.addReceipt({ key, fingerprint: hash, result: completed, at: now() }, RECEIPT_LIMIT);
          confirmations.clear();
          return result(null, completed);
        });
      } catch (_error) {
        return result("commit_failed", { state: current() });
      }
      return { ...(answer || result("busy")), state: current() };
    }
    return Object.freeze({ dispatch, reset: () => { confirmations.clear(); transportEpoch = null; }, snapshot: current });
  }

  function createTransport(options) {
    const endpoint = "http://127.0.0.1:8768";
    const fetcher = options.fetch;
    const pause = options.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let stopped = true, activeToken = "", generation = 0;
    const inFlight = new Set();
    let publishBusy = false, publishAgain = false, publishGeneration = 0;
    const instanceId = options.instanceId;
    const connectionState = (state) => { if (options.onConnection) options.onConnection(state); };
    async function request(path, body, timeoutMs, token = activeToken) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      inFlight.add(controller);
      try {
        const response = await fetcher(endpoint + path, { method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
          headers: { "Content-Type": "application/json", "X-Study-Timer-Token": token },
          body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) throw new Error("connection_rejected");
        return await response.json();
      } finally { clearTimeout(timer); inFlight.delete(controller); }
    }
    async function publish() {
      if (stopped || !options.controller.snapshot().writer) return;
      const ownGeneration = generation;
      if (publishBusy && publishGeneration === ownGeneration) { publishAgain = true; return; }
      publishBusy = true; publishGeneration = ownGeneration;
      try {
        do {
          publishAgain = false;
          await request("/timer/state", { instanceId, state: options.controller.snapshot() }, 4000);
        } while (publishAgain && !stopped && generation === ownGeneration);
      } catch (_error) { if (!stopped && generation === ownGeneration) connectionState("disconnected"); }
      finally { if (publishGeneration === ownGeneration) publishBusy = false; }
    }
    async function loop(ownGeneration) {
      let retry = 1000;
      while (!stopped && generation === ownGeneration) {
        if (!options.controller.snapshot().writer) { connectionState("not_writer"); await pause(3000); continue; }
        try {
          const packet = await request("/timer/poll", { instanceId, state: options.controller.snapshot() }, 24000);
          if (stopped || generation !== ownGeneration) break;
          if (!packet || typeof packet.epoch !== "string") throw new Error("invalid_response");
          connectionState("connected"); retry = 1000;
          if (packet.command) {
            const answer = await options.controller.dispatch({ ...packet.command, transportEpoch: packet.epoch });
            if (!stopped && generation === ownGeneration) {
              // A failed acknowledgement is never a reason to replay an action.
              await request("/timer/result", { instanceId, requestId: packet.command.requestId, client: packet.command.client,
                result: answer, state: options.controller.snapshot() }, 4000);
            }
          }
        } catch (_error) {
          if (stopped || generation !== ownGeneration) break;
          connectionState("disconnected"); await pause(retry); retry = Math.min(30000, retry * 2);
        }
      }
    }
    function stop() {
      stopped = true; generation += 1; activeToken = ""; publishAgain = false;
      for (const request of inFlight) request.abort();
      inFlight.clear(); options.controller.reset(); connectionState("disabled");
    }
    function start(token) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return false;
      stop(); activeToken = token; stopped = false; const own = ++generation; void loop(own); return true;
    }
    return Object.freeze({ start, stop, publish, isEnabled: () => !stopped });
  }
  return Object.freeze({ CLIENTS: [...CLIENTS], ACTIONS: [...ACTIONS], REASONS, statusOf, snapshot, validate, createController, createTransport });
}));
