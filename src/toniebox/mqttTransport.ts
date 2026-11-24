import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { Duplex, Transform } from 'node:stream';

import { MqttClient } from 'mqtt';
import WebSocket, { createWebSocketStream } from 'ws';
import type { MqttCredentials, MqttFailure, MqttMessage, MqttResult, MqttRoute,
  MqttStatus, MqttTransport, MqttTransportOptions, PlaybackPublishFailure, PlaybackPublishResult } from './mqttTransportTypes.js';

const PACKET_LIMIT = 128 * 1024;
const PAYLOAD_LIMIT = 64 * 1024;
const BUFFER_LIMIT = 1024 * 1024;
const PUBLISH_ACK_MS = 3000;
const COMMAND_PAYLOAD_LIMIT = 64;
const PUBACK_REASONS = new Set([0, 16, 128, 131, 135, 144, 145, 151, 153]);
interface Publication {
  readonly topic: string;
  readonly payload: string;
  deadline: number;
  readonly owner: MqttClient;
  readonly resolve: (result: PlaybackPublishResult) => void;
  invoked: boolean;
  packetId?: number;
  acknowledgement?: number;
  callbackDone: boolean;
  callbackFailed: boolean;
  timerEpoch?: object;
  cancelTimer?: () => void;
  removeAbort?: () => void;
}
const SUFFIXES = ['metrics/battery', 'online-state', 'metrics/headphones', 'settings-applied',
  'playback/state', 'volume/state', 'app-reply/bedtime-state'] as const;
const require = createRequire(import.meta.url);
const packetRequire = createRequire(createRequire(require.resolve('mqtt/package.json')).resolve('mqtt-packet'));
/**
 * Read the actual dependency's debug instance; never change shared settings.
 * Accepted limitation: runtime tracing can expose bytes already admitted downstream.
 * These checks protect entry boundaries, not atomic confidentiality inside MQTT.js.
 */
function tracing(): boolean {
  const debug = packetRequire('debug') as { enabled(namespace: string): boolean };
  return debug.enabled('mqtt-packet:parser') || debug.enabled('mqtt-packet:writeToStream');
}
const ignoreError = (): void => undefined;
const safeError = (kind: MqttFailure['kind']): Error => Object.assign(new Error(kind), { code: kind });

/**
 * Fixed-header framing only, before MQTT.js decoding. Retains at most five header bytes.
 * Bodies are forwarded as views; stream/WebSocket buffers have separate bounds.
 * Exported for deterministic boundary tests, not a general MQTT parser.
 */
export function createPacketGuard(): Transform {
  let header = Buffer.alloc(5);
  let count = 0;
  let length = 0;
  let multiplier = 1;
  let remaining = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      try {
        if (tracing()) {
          throw safeError('unsafe-tracing');
        }
        let offset = 0;
        while (offset < chunk.length && !this.destroyed) {
          if (remaining > 0) {
            const size = Math.min(remaining, chunk.length - offset);
            this.push(chunk.subarray(offset, offset + size));
            remaining -= size;
            offset += size;
          } else if (count === 0) {
            header[count++] = chunk[offset++];
          } else {
            const byte = chunk[offset++];
            header[count++] = byte;
            length += (byte & 127) * multiplier;
            if (byte & 128) {
              if (count === 5) {
                throw safeError('protocol');
              }
              multiplier *= 128;
            } else {
              if (count > 2 && byte === 0) {
                throw safeError('protocol');
              }
              if (count + length > PACKET_LIMIT) {
                throw safeError('resource-limit');
              }
              this.push(Buffer.from(header.subarray(0, count)));
              remaining = length;
              count = length = 0;
              multiplier = 1;
            }
          }
        }
        done();
      } catch (error) {
        done(error instanceof Error && ['protocol', 'resource-limit', 'unsafe-tracing'].includes(error.message)
          ? error : safeError('dependency'));
      }
    },
    flush(done) {
      done(count || remaining ? safeError('protocol') : undefined);
    },
    destroy(error, done) {
      header = Buffer.alloc(0);
      count = length = remaining = 0;
      done(error);
    },
  });
}

function productionStream(): Duplex {
  const socket = new WebSocket('wss://ici.tonie.cloud:443/', ['mqtt'], {
    rejectUnauthorized: true, followRedirects: false, maxPayload: BUFFER_LIMIT,
    perMessageDeflate: false, handshakeTimeout: 20000,
  });
  return createWebSocketStream(socket, { highWaterMark: PAYLOAD_LIMIT });
}
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256
  && !/\s/u.test(v) && [...v].every(c => c.charCodeAt(0) > 31 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159));

/** Single-use adapter. No token acquisition, session generation or reconnect policy. Publishing is explicitly opt-in. */
export function createMqttTransport(options: MqttTransportOptions): MqttTransport {
  if (!options || typeof options.onMessage !== 'function'
    || (options.onStatus !== undefined && typeof options.onStatus !== 'function')
    || (options.streamFactory !== undefined && typeof options.streamFactory !== 'function')
    || (options.clientFactory !== undefined && typeof options.clientFactory !== 'function')
    || (options.clock !== undefined && typeof options.clock?.now !== 'function')
    || (options.scheduler !== undefined && typeof options.scheduler?.schedule !== 'function')) {
    throw new TypeError('Invalid MQTT transport options');
  }
  const clock = options.clock ?? { now: () => ({ monotonicMs: performance.now(), wallMs: Date.now() }) };
  const scheduler = options.scheduler ?? { schedule(callback: () => void, ms: number) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  } };
  let status: MqttStatus = { phase: 'idle' };
  let client: MqttClient | undefined;
  let raw: Duplex | undefined;
  let guarded: Duplex | undefined;
  let gate: Transform | undefined;
  let cancelTimer: (() => void) | undefined;
  let removeAbort: (() => void) | undefined;
  let resolve: ((result: MqttResult) => void) | undefined;
  let start = 0;
  let deadline = 0;
  let lastTime = -Infinity;
  let queued: MqttMessage[] = [];
  let bytes = 0;
  let draining = false;
  let streamBuilt = false;
  let connectCalled = false;
  const topics = new Map<string, string>();
  const playbackTopics = new Map<string, string>();
  // Never reuse a command packet ID in this single-use client: a late ACK cannot
  // complete another command. Bounded by MQTT's 65,535 packet identifiers.
  const usedPublishIds = new Set<number>();
  let publication: Publication | undefined;
  let dispatching = false;
  let settling = false;
  const active = (): boolean => status.phase !== 'closed';
  const now = (): { monotonicMs: number; wallMs: number } => {
    const value = clock.now();
    if (!Number.isFinite(value.monotonicMs) || value.monotonicMs < 0 || value.monotonicMs < lastTime
      || !Number.isSafeInteger(value.wallMs) || value.wallMs < 0) {
      throw safeError('dependency');
    }
    lastTime = value.monotonicMs;
    return value;
  };
  const notify = (): void => {
    try {
      options.onStatus?.({ ...status, ...(status.error ? { error: { ...status.error } } : {}) });
    } catch {
      // Owner exceptions never enter diagnostics or escape MQTT event handlers.
    }
  };
  let finish: (error: MqttFailure) => void;
  const check = (): boolean => {
    if (!active()) {
      return false;
    }
    try {
      if (status.phase !== 'ready' && now().monotonicMs >= deadline) {
        finish({ kind: 'timeout' });
        return false;
      }
      if (tracing()) {
        finish({ kind: 'unsafe-tracing' });
        return false;
      }
      return true;
    } catch {
      finish({ kind: 'dependency' });
      return false;
    }
  };
  const arm = (): void => {
    cancelTimer?.();
    const marker = deadline;
    cancelTimer = scheduler.schedule(() => {
      if (!active() || deadline !== marker || status.phase === 'ready') {
        return;
      }
      if (check()) {
        try {
          arm();
        } catch {
          finish({ kind: 'dependency' });
        }
      }
    }, Math.max(1, Math.ceil(deadline - now().monotonicMs)));
  };
  const publishFailure = (reason: PlaybackPublishFailure, invoked = false): PlaybackPublishResult => ({
    ok: false, reason, delivery: invoked ? 'uncertain' : 'not-dispatched',
  });
  const settlePublication = (p: Publication, result: PlaybackPublishResult): void => {
    if (publication !== p) {
      return;
    }
    publication = undefined; // Revoke before timer, signal and library callbacks can reenter.
    p.timerEpoch = undefined;
    settling = true;
    let cleanupFailed = false;
    try {
      try {
        p.cancelTimer?.();
      } catch { /* Deadline callbacks also check ownership. */ }
      try {
        p.removeAbort?.();
      } catch {
        cleanupFailed = true;
      }
      if (p.packetId !== undefined && (!p.callbackDone || p.acknowledgement === undefined)) {
        try {
          p.owner.removeOutgoingMessage(p.packetId);
        } catch {
          cleanupFailed = true;
        }
      }
      p.resolve(result);
      if (cleanupFailed || (p.invoked && p.packetId === undefined)) {
        // A queued/untrackable command cannot be allowed to dispatch later.
        finish({ kind: 'dependency' });
      }
    } finally {
      settling = false;
    }
  };
  const publicationCurrent = (p: Publication): boolean => {
    if (publication !== p) {
      return false;
    }
    try {
      if (status.phase !== 'ready' || client !== p.owner || !p.owner.connected) {
        settlePublication(p, publishFailure(active() ? 'interrupted' : 'closed', p.invoked));
        return false;
      }
      if (now().monotonicMs >= p.deadline) {
        settlePublication(p, publishFailure('timeout', p.invoked));
        return false;
      }
      if (tracing()) {
        settlePublication(p, publishFailure('unsafe-tracing', p.invoked));
        finish({ kind: 'unsafe-tracing' });
        return false;
      }
      return publication === p && status.phase === 'ready';
    } catch {
      settlePublication(p, publishFailure('dependency', p.invoked));
      return false;
    }
  };
  const completePublication = (p: Publication): void => {
    if (!publicationCurrent(p) || !p.callbackDone) {
      return;
    }
    const reason = p.acknowledgement;
    if (reason === 16) {
      settlePublication(p, publishFailure('no-subscribers', true));
    } else if (reason !== undefined && reason !== 0) {
      settlePublication(p, publishFailure('broker-refused', true));
    } else if (p.callbackFailed) {
      settlePublication(p, publishFailure('publish-error', true));
    } else if (reason === 0) {
      settlePublication(p, { ok: true, acknowledgement: 'broker' });
    }
    // A callback without a matching PUBACK is not success; the deadline still applies.
  };
  function onPacketSend(packet: { cmd: string; topic?: string; payload?: unknown; qos?: number; retain?: boolean; messageId?: number }): void {
    const p = publication;
    try {
      if (packet.cmd !== 'publish') {
        return;
      }
      if (!p || !p.invoked || !publicationCurrent(p)) {
        finish({ kind: 'protocol' }); return;
      }
      const id = packet.messageId;
      if (p.packetId !== undefined || !Number.isInteger(id) || id === undefined || id < 1 || id > 65535
        || usedPublishIds.has(id) || packet.topic !== p.topic || packet.qos !== 1 || packet.retain !== false
        || !(typeof packet.payload === 'string' || Buffer.isBuffer(packet.payload))
        || packet.payload.toString() !== p.payload) {
        settlePublication(p, publishFailure('dependency', true));
        finish({ kind: 'protocol' }); return;
      }
      p.packetId = id;
      usedPublishIds.add(id);
    } catch {
      if (p) {
        settlePublication(p, publishFailure('dependency', p.invoked));
      }
      finish({ kind: 'dependency' });
    }
  }
  function onPacketReceive(packet: { cmd: string; messageId?: number; reasonCode?: number }): void {
    const p = publication;
    if (!p) {
      return;
    }
    try {
      if (packet.cmd !== 'puback' || packet.messageId !== p.packetId || p.packetId === undefined) {
        return; // Unrelated and late ACKs cannot acquire an operation's authority.
      }
      if (!publicationCurrent(p) || p.acknowledgement !== undefined) {
        return;
      }
      const code = packet.reasonCode === undefined ? 0 : packet.reasonCode;
      if (!Number.isInteger(code) || !PUBACK_REASONS.has(code)) {
        settlePublication(p, publishFailure('invalid-acknowledgement', true)); return;
      }
      p.acknowledgement = code;
      completePublication(p);
    } catch {
      settlePublication(p, publishFailure('invalid-acknowledgement', p.invoked));
    }
  }
  const armPublication = (p: Publication): void => {
    let installing = true;
    const epoch = p.timerEpoch = {};
    const cancel = scheduler.schedule(() => {
      if (publication !== p || p.timerEpoch !== epoch) {
        return;
      }
      p.timerEpoch = undefined;
      if (installing) {
        settlePublication(p, publishFailure('dependency', p.invoked)); return;
      }
      if (publicationCurrent(p)) {
        try {
          armPublication(p);
        } catch {
          settlePublication(p, publishFailure('dependency', p.invoked));
        }
      }
    }, Math.max(1, Math.ceil(p.deadline - now().monotonicMs)));
    installing = false;
    if (publication === p) {
      p.cancelTimer = cancel;
    } else {
      try {
        cancel();
      } catch { /* Already revoked. */ }
    }
  };
  const deliver = (message: MqttMessage): void => {
    if (!check()) {
      return;
    }
    try {
      options.onMessage(message);
    } catch {
      finish({ kind: 'dependency' });
    }
  };
  function onMessage(topic: string, payload: Buffer, packet: { retain: boolean; qos: number; dup: boolean }): void {
    if (!check()) {
      return;
    }
    if (!topics.has(topic)) {
      return;
    }
    try {
      if (status.phase === 'connecting' || !(payload instanceof Uint8Array)
        || !packet || typeof packet.retain !== 'boolean' || typeof packet.dup !== 'boolean'
        || (packet.qos !== 0 && packet.qos !== 1)) {
        finish({ kind: 'protocol' });
        return;
      }
      if (payload.byteLength > PAYLOAD_LIMIT) {
        finish({ kind: 'resource-limit' });
        return;
      }
      const message: MqttMessage = {
        routeId: topics.get(topic)!, topic, payload: Uint8Array.from(payload), retained: packet.retain,
        qos: packet.qos, duplicate: packet.dup, receivedAtMs: now().wallMs,
      };
      if (status.phase !== 'ready' || draining) {
        if (queued.length >= 1024 || bytes + payload.byteLength > BUFFER_LIMIT) {
          finish({ kind: 'resource-limit' });
          return;
        }
        queued.push(message);
        bytes += payload.byteLength;
      } else {
        deliver(message);
      }
    } catch {
      finish({ kind: 'dependency' });
    }
  }
  function onConnect(packet: { reasonCode?: number; sessionPresent: boolean }): void {
    if (!check()) {
      return;
    }
    if (status.phase !== 'connecting' || !packet || packet.reasonCode !== 0 || packet.sessionPresent !== false) {
      finish({ kind: 'protocol' });
      return;
    }
    try {
      status = { phase: 'subscribing' };
      deadline = Math.min(start + 30000, now().monotonicMs + 10000);
      arm();
      notify();
      if (!check()) {
        return;
      }
      const request = Object.fromEntries([...topics.keys()].map(topic => [topic, { qos: 1 as const, rap: false, rh: 0 as const }]));
      let acknowledged = false;
      client!.subscribe(request, (error, granted) => {
        if (!check() || acknowledged) {
          return;
        }
        acknowledged = true;
        try {
          if (error || !Array.isArray(granted) || granted.length !== topics.size
            || granted.some(g => !g || typeof g.topic !== 'string')
            || new Set(granted.map(g => g.topic)).size !== topics.size
            || granted.some(g => !topics.has(g.topic) || g.qos !== 1)) {
            finish({ kind: 'subscription-refused' });
            return;
          }
          cancelTimer?.();
          cancelTimer = undefined;
          status = { phase: 'ready' };
          draining = true;
          notify();
          while (queued.length && active()) {
            const message = queued.shift()!;
            bytes -= message.payload.byteLength;
            deliver(message);
          }
          draining = false;
          if (active()) {
            const settled = resolve;
            resolve = undefined;
            settled?.({ ok: true });
          }
        } catch {
          finish({ kind: 'dependency' });
        }
      });
    } catch {
      finish({ kind: 'dependency' });
    }
  }
  function failure(error: unknown, origin: 'disconnect' | 'error'): void {
    if (!active()) {
      return;
    }
    let code: unknown;
    try {
      code = (error as { code?: unknown })?.code;
    } catch { /* No raw error text. */ }
    const reason = typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined;
    const kind = code === 'unsafe-tracing' ? 'unsafe-tracing' : code === 'resource-limit' ? 'resource-limit'
      : code === 'protocol' ? 'protocol' : reason === 134 || reason === 135 ? 'authentication-refused' : 'transport';
    finish({ kind, ...(reason === undefined ? {} : { reasonCode: reason }),
      ...(kind === 'authentication-refused' ? { origin } : {}) });
  }
  function onClose(): void {
    finish({ kind: 'transport' });
  }
  function onError(error: unknown): void {
    failure(error, 'error');
  }
  function onDisconnect(packet: { reasonCode?: number }): void {
    try {
      failure({ code: packet?.reasonCode }, 'disconnect');
    } catch {
      finish({ kind: 'dependency' });
    }
  }
  const disposeClient = (owned: MqttClient): void => {
    owned.removeListener('packetsend', onPacketSend);
    owned.removeListener('packetreceive', onPacketReceive);
    owned.removeListener('connect', onConnect);
    owned.removeListener('message', onMessage);
    owned.removeListener('close', onClose);
    owned.removeListener('disconnect', onDisconnect);
    owned.removeListener('error', onError);
    owned.on('error', ignoreError);
    try {
      owned.options.password = undefined;
      owned.options.username = undefined;
      owned.end(true);
    } catch { /* Independent stream disposal must still run. */ }
  };
  const detachStream = (owned: Duplex): void => {
    owned.removeListener('error', onError);
    owned.on('error', ignoreError);
  };
  const destroyStream = (owned: Duplex): void => {
    try {
      owned.destroy();
    } catch { /* Even uncooperative test dependencies cannot prevent settlement. */ }
  };
  finish = (error: MqttFailure): void => {
    if (!active()) {
      return;
    }
    status = { phase: 'closed', error };
    finish = () => undefined; // Terminal disposal is also inert during reentrant cleanup callbacks.
    if (publication) {
      const reason = error.kind === 'closed' ? 'closed' : error.kind === 'cancelled' ? 'cancelled'
        : error.kind === 'unsafe-tracing' ? 'unsafe-tracing' : 'interrupted';
      settlePublication(publication, publishFailure(reason, publication.invoked));
    }
    playbackTopics.clear();
    usedPublishIds.clear();
    const settled = resolve;
    resolve = undefined;
    try {
      cancelTimer?.();
    } catch { /* Late callbacks check terminal state. */ }
    cancelTimer = undefined;
    removeAbort?.();
    removeAbort = undefined;
    queued = [];
    bytes = 0;
    topics.clear();
    if (client) {
      disposeClient(client);
    }
    // Release only our listeners; library cleanup owns its own stream listeners.
    const streams = [guarded, raw, gate].filter((value): value is Duplex => value !== undefined);
    for (const stream of streams) {
      detachStream(stream);
    }
    if (raw && gate) {
      raw.unpipe(gate);
    }
    for (const stream of streams) {
      destroyStream(stream);
    }
    client = undefined;
    raw = guarded = gate = undefined;
    settled?.({ ok: false, error: { ...error } });
    notify();
  };
  return {
    getStatus: () => ({ ...status, ...(status.error ? { error: { ...status.error } } : {}) }),
    close: () => finish({ kind: 'closed' }),
    publishPlayback(routeId, action, requestOptions = {}): Promise<PlaybackPublishResult> {
      let signal: AbortSignal | undefined;
      try {
        if (!text(routeId) || !['play', 'pause'].includes(action) || !requestOptions
          || typeof requestOptions !== 'object' || Array.isArray(requestOptions)) {
          return Promise.resolve(publishFailure('invalid-input'));
        }
        signal = requestOptions.signal;
        if (signal !== undefined && !(signal instanceof AbortSignal)) {
          return Promise.resolve(publishFailure('invalid-input'));
        }
        if (signal?.aborted) {
          return Promise.resolve(publishFailure('cancelled'));
        }
        if (!active()) {
          return Promise.resolve(publishFailure('closed'));
        }
        if (status.phase !== 'ready' || !client?.connected) {
          return Promise.resolve(publishFailure('not-ready'));
        }
        const topic = playbackTopics.get(routeId);
        if (!topic) {
          return Promise.resolve(publishFailure('not-authorised'));
        }
        if (publication || dispatching || settling || usedPublishIds.size >= 65535) {
          return Promise.resolve(publishFailure('capacity'));
        }
        const payload = action === 'play' ? '{"action":"start"}' : '{"action":"pause"}';
        if (Buffer.byteLength(payload) > COMMAND_PAYLOAD_LIMIT) {
          return Promise.resolve(publishFailure('invalid-input'));
        }
        const owner = client;
        dispatching = true;
        return new Promise<PlaybackPublishResult>(done => {
          const p: Publication = { topic, payload, owner, resolve: done, deadline: 0,
            invoked: false, callbackDone: false, callbackFailed: false };
          try {
            // Install ownership before clock/scheduler/signal seams can reenter.
            publication = p;
            p.deadline = now().monotonicMs + PUBLISH_ACK_MS;
            if (publication !== p) {
              return;
            }
            const abort = (): void => settlePublication(p, publishFailure('cancelled', p.invoked));
            p.removeAbort = () => signal?.removeEventListener('abort', abort);
            signal?.addEventListener('abort', abort, { once: true });
            if (publication !== p) {
              p.removeAbort(); return;
            }
            if (signal?.aborted) {
              abort();
            }
            if (publication !== p) {
              return;
            }
            armPublication(p);
            if (!publicationCurrent(p)) {
              return;
            }
            p.invoked = true; // Calling the library makes downstream delivery uncertain, even if it throws.
            owner.publish(topic, payload, { qos: 1, retain: false }, error => {
              if (publication !== p || p.callbackDone) {
                return;
              }
              p.callbackDone = true; p.callbackFailed = !!error;
              completePublication(p);
            });
            if (publication === p && p.packetId === undefined) {
              settlePublication(p, publishFailure('dependency', true)); // No offline/library queue accepted.
            }
          } catch {
            settlePublication(p, publishFailure('dependency', p.invoked));
          } finally {
            dispatching = false;
          }
        });
      } catch {
        dispatching = false;
        return Promise.resolve(publishFailure('invalid-input'));
      }
    },
    connect(credentials: MqttCredentials, routes: readonly MqttRoute[], requestOptions = {}): Promise<MqttResult> {
      if (status.phase !== 'idle' || connectCalled) {
        return Promise.resolve({ ok: false, error: { kind: 'closed' } });
      }
      // Claim single-use ownership before input getters or injected clock callbacks can reenter.
      connectCalled = true;
      try {
        if (!credentials || !text(credentials.uuid) || typeof credentials.accessToken !== 'string'
          || !/^[\x21-\x7e]+$/u.test(credentials.accessToken) || credentials.accessToken.length > 65535
          || !Array.isArray(routes) || routes.length < 1 || routes.length > 100
          || !requestOptions || (requestOptions.signal !== undefined && !(requestOptions.signal instanceof AbortSignal))) {
          throw safeError('invalid-input');
        }
        const ids = new Set<string>();
        const macs = new Set<string>();
        let size = 0;
        const commandRoutes = new Map<string, string>();
        for (const route of routes) {
          if (!route) {
            throw safeError('invalid-input');
          }
          const routeId = route.routeId, macAddress = route.macAddress;
          if (!text(routeId) || !text(macAddress) || /[/\\+#]/u.test(macAddress)) {
            throw safeError('invalid-input');
          }
          const mac = macAddress.toUpperCase();
          if (ids.has(routeId) || macs.has(mac)) {
            throw safeError('invalid-input');
          }
          ids.add(routeId);
          macs.add(mac);
          commandRoutes.set(routeId, 'external/toniebox/' + mac + '/app-control/playback');
          for (const suffix of SUFFIXES) {
            const topic = 'external/toniebox/' + mac + '/' + suffix;
            size += Buffer.byteLength(topic) + 3;
            topics.set(topic, routeId);
          }
        }
        const requestedPermissions = requestOptions.playbackRouteIds;
        const permissions = requestedPermissions === undefined ? [] : requestedPermissions;
        if (!Array.isArray(permissions) || permissions.length > routes.length) {
          throw safeError('invalid-input');
        }
        for (const id of permissions) {
          if (!text(id) || !commandRoutes.has(id) || playbackTopics.has(id)) {
            throw safeError('invalid-input');
          }
          playbackTopics.set(id, commandRoutes.get(id)!);
        }
        if (size > PAYLOAD_LIMIT) {
          throw safeError('invalid-input');
        }
      } catch {
        finish({ kind: 'invalid-input' });
        return Promise.resolve({ ok: false, error: { kind: 'invalid-input' } });
      }
      if (status.phase !== 'idle') {
        return Promise.resolve({ ok: false, error: { kind: 'closed' } });
      }
      return new Promise<MqttResult>(done => {
        resolve = done;
        const signal = requestOptions.signal;
        const abort = (): void => finish({ kind: 'cancelled' });
        signal?.addEventListener('abort', abort, { once: true });
        removeAbort = () => signal?.removeEventListener('abort', abort);
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          start = now().monotonicMs;
          deadline = start + 20000;
          status = { phase: 'connecting' };
          if (!check()) {
            return;
          }
          const builder = (): Duplex => {
            if (!check() || streamBuilt) {
              throw safeError('closed');
            }
            streamBuilt = true;
            raw = (options.streamFactory ?? productionStream)();
            if (!active()) {
              detachStream(raw);
              destroyStream(raw);
              raw = undefined;
              throw safeError('closed');
            }
            gate = createPacketGuard();
            gate.on('error', onError);
            raw.on('error', onError);
            guarded = Duplex.from({ readable: raw.pipe(gate), writable: raw });
            guarded.on('error', onError);
            return guarded;
          };
          client = (options.clientFactory ?? ((build, config) => new MqttClient(build, config)))(builder, {
            manualConnect: true, protocolVersion: 5, clean: true, reconnectPeriod: 0, resubscribe: false,
            reconnectOnConnackError: false, queueQoSZero: false, keepalive: 60,
            clientId: 'hb-' + randomUUID(), username: credentials.uuid, password: credentials.accessToken,
            connectTimeout: 20000, log: () => undefined,
            properties: { sessionExpiryInterval: 0, maximumPacketSize: PACKET_LIMIT, topicAliasMaximum: 0 },
          });
          if (!active()) {
            disposeClient(client);
            client = undefined;
            return;
          }
          if (playbackTopics.size) {
            client.on('packetsend', onPacketSend);
            client.on('packetreceive', onPacketReceive);
          }
          client.on('error', onError);
          client.on('close', onClose);
          client.on('disconnect', onDisconnect);
          client.on('connect', onConnect);
          client.on('message', onMessage);
          arm();
          notify();
          if (check()) {
            client.connect();
          }
        } catch {
          finish({ kind: 'dependency' });
        }
      });
    },
  };
}
