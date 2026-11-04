import assert from 'node:assert/strict';
import net from 'node:net';
import { after, afterEach, before, mock, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
const { TextEncoder, AbortController } = globalThis;
let createAccountCoordinator, createMqttLifecycle;
let attempts = 0;
const coordinators = [];
before(async () => {
  const deny = () => {
    attempts++; throw new Error('Forbidden network');
  };
  mock.method(globalThis, 'fetch', deny);
  mock.method(net.Socket.prototype, 'connect', deny);
  mock.method(globalThis, 'setTimeout', deny);
  mock.method(globalThis, 'setInterval', deny);
  ({ createAccountCoordinator } = await import('../dist/toniebox/accountCoordinator.js'));
  ({ createMqttLifecycle } = await import('../dist/toniebox/mqttLifecycle.js'));
});
afterEach(async () => {
  for (const c of coordinators.splice(0)) {
    c.stop();
  }
  await turn(); assert.equal(attempts, 0);
});
after(() => {
  mock.restoreAll();
});
const credentials = { username: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' };
const diagnostics = { rejectedEntries: 0, degradedEntries: 0, duplicateEntries: 0, ambiguousRoutingEntries: 0, continuationDetected: false };
const ok = value => ({ ok: true, value, diagnostics: { ...diagnostics } });
const box = (id = 'SYNTHETIC_A', extra = {}) => ({ id, macAddress: id + '_MAC', product: 'tb2', generation: 'tng', features: ['playbackControls'], ...extra });
const deferred = () => {
  let resolve, reject; const promise = new Promise((a,b) => {
    resolve=a; reject=b;
  }); return { promise, resolve, reject };
};
async function drain() {
  for (let i=0;i<60;i++) {
    await Promise.resolve();
  }
}
function fixture(extra = {}) {
  let time = 0;
  const jobs = new Set(), lifecycles = [], calls = [], notices = [];
  const scheduler = { schedule(fn, ms) {
    const job={ fn,ms }; jobs.add(job); return () => jobs.delete(job);
  } };
  const f = { jobs, lifecycles, calls, notices, boxes: [box()], account: { id: 'SYNTHETIC_ACCOUNT', identitySource: 'uuid' },
    accountResult: undefined, boxesResult: undefined, authResult: undefined };
  const clock = { now: () => ({ monotonicMs: time, wallMs: time }) };
  const authClient = { login: async () => {
    calls.push('login'); return f.authResult ?? { ok: true, tokens: {
      accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', tokenType: 'Bearer', expiresInSeconds: 300,
    } };
  }, refresh: async () => {
    throw new Error('Unexpected refresh');
  } };
  const discoveryClient = {
    getAccount: async () => {
      calls.push('account'); return f.accountResult ?? ok(f.account);
    },
    getHouseholds: async () => {
      calls.push('households'); return ok([{ id: 'SYNTHETIC_HOUSE' }]);
    },
    getTonieboxes: async () => {
      calls.push('boxes'); return f.boxesResult ?? ok(f.boxes);
    },
  };
  const lifecycleFactory = options => {
    const l = { options, stops: 0, starts: 0, phase: 'idle', start() {
      this.starts++; this.phase='ready'; options.onStatus({ phase:'ready', connected:true, session:1 });
    }, stop() {
      this.stops++; this.phase='stopped';
    }, getStatus() {
      return { phase:this.phase, connected:this.phase==='ready' };
    } };
    lifecycles.push(l); return l;
  };
  f.c = createAccountCoordinator({ authClient, discoveryClient, clock, scheduler, lifecycleFactory,
    onStatus: status => {
      notices.push(status); return extra.observer?.(status, f);
    }, ...extra.options });
  coordinators.push(f.c);
  f.advance = ms => {
    time += ms;
  };
  f.begin = async () => {
    assert.equal(f.c.setCredentials(credentials).ok,true); f.c.start(); return f.c.discover();
  };
  f.message = (l = lifecycles[0], level = 4) => l.options.onMessage({ routeId: 'SYNTHETIC_A',
    topic: 'external/toniebox/SYNTHETIC_A_MAC/volume/state', payload: new TextEncoder().encode(JSON.stringify({ level })),
    receivedAtMs: 1000, session: 1, retained: true, duplicate: false, qos: 1 });
  return f;
}
test('construction and credential supply are inert; start shares one discovery', async () => {
  const f=fixture(); assert.deepEqual(f.calls,[]); assert.equal(f.jobs.size,0);
  f.c.setCredentials(credentials); assert.deepEqual(f.calls,[]);
  f.c.start(); await Promise.all(Array.from({ length:20 },()=>f.c.discover()));
  assert.deepEqual(f.calls,['login','account','households','boxes']);
  assert.equal(f.lifecycles.length,1); assert.equal(f.c.getStatus().phase,'connected');
});
test('multiple devices use one production lifecycle and private states', async () => {
  const f=fixture(); f.boxes=[box(),box('SYNTHETIC_B')]; await f.begin();
  assert.equal(f.lifecycles[0].options.routes.length,2); f.message();
  assert.equal(f.c.getDevice('SYNTHETIC_A').state.topics['volume/state'].value.level,4);
  assert.deepEqual(f.c.getDevice('SYNTHETIC_B').state.topics,{});
});
test('identical credentials and unchanged rediscovery preserve binding and lifecycle', async () => {
  const f=fixture(); await f.begin(); f.message();
  f.c.setCredentials({ ...credentials }); await f.c.discover();
  assert.equal(f.lifecycles.length,1); assert.equal(f.lifecycles[0].starts,1);
  assert.equal(f.c.getDevice('SYNTHETIC_A').freshness['volume/state'],'retained');
});
for (const mode of ['failure','partial','metadata']) {
  test(mode+' discovery preserves healthy production without speculative routes', async () => {
    const f=fixture(); await f.begin(); f.message();
    if(mode==='failure') {
      f.accountResult={ ok:false,error:{ kind:'invalid-response' } };
    }
    if(mode==='partial') {
      f.boxesResult={ ...ok([box('NEW')]),diagnostics:{ ...diagnostics,rejectedEntries:1 } };
    }
    if(mode==='metadata') {
      f.boxes=[box(undefined,{ features:[] }),box('NEW',{ features:[] })];
    }
    await f.c.discover(); assert.equal(f.lifecycles.length,1); assert.equal(f.lifecycles[0].stops,0);
    assert.equal(f.c.getDevice('NEW'),undefined); assert.equal(f.c.getStatus().authority,'last-known');
  });
}
for(const mode of ['absence','conflict','replacement']) {
  test(mode+' revokes old callbacks before replacement', async()=>{
    const f=fixture(); await f.begin(); const old=f.lifecycles[0];
    f.boxes=mode==='absence'?[]:mode==='conflict'?[box(),box('OTHER',{ macAddress:box().macAddress })]:[box(),box('NEW')];
    await f.c.discover(); f.message(old,99);
    assert.equal(old.stops,1);
    assert.equal(f.c.getDevice('SYNTHETIC_A')?.state.topics['volume/state'],undefined);
    assert.equal(f.lifecycles.length,mode==='replacement'?2:1);
  });
}
const restriction={ rules:[{ product:'tb2',generation:'tng',family:'toniebox-2',decision:'unsupported',evidence:'SYNTHETIC' }] };
test('policy restriction revokes without network and invalid policy cannot grant or revoke',async()=>{
  const f=fixture(); await f.begin(); const n=f.calls.length;
  f.c.setPolicy({ rules:'bad' }); assert.equal(f.lifecycles[0].stops,0);
  f.c.setPolicy(restriction); assert.equal(f.lifecycles[0].stops,1); assert.equal(f.calls.length,n);
});
test('experiments have separate connections and bindings; production remains healthy',async()=>{
  const policy={ rules:[{ product:'SYNTHETIC_MODEL',
    generation:'SYNTHETIC_GEN',family:'unknown',decision:'experimental',protocol:'ici-seven-state-topics',evidence:'SYNTHETIC' }] };
  const f=fixture({ options:{ policy } }); f.boxes=[box(),box('EXP',{ product:'SYNTHETIC_MODEL',generation:'SYNTHETIC_GEN' })];
  await f.begin(); assert.equal(f.lifecycles.length,2); f.message();
  assert.equal(f.c.getDevice('EXP'),undefined); assert.ok(f.c.getDevice('EXP','experimental'));
  await f.c.discover(); assert.equal(f.lifecycles.length,2);
  f.accountResult={ ok:false,error:{ kind:'invalid-response' } }; await f.c.discover();
  assert.equal(f.lifecycles[0].stops,0); assert.equal(f.lifecycles[1].stops,1);
});
for(const action of ['clear','invalidate','stop']) {
  test(action+' settles pending discovery and ignores late results',async()=>{
    const f=fixture(); const late=deferred(); f.accountResult=late.promise;
    f.c.setCredentials(credentials); f.c.start(); const pending=f.c.discover(); await drain();
    f.c[action](); assert.equal((await pending).ok,false);
    late.resolve(ok(f.account)); await drain(); assert.equal(f.lifecycles.length,0);
    assert.equal(f.c.getDevice('SYNTHETIC_A'),undefined); f.c.stop(); assert.equal(f.jobs.size,0);
  });
}
test('changed credentials revoke old discovery and MQTT authority',async()=>{
  const f=fixture(); await f.begin(); const old=f.lifecycles[0];
  f.c.setCredentials({ ...credentials,password:'SYNTHETIC_NEW' }); f.message(old,99);
  assert.equal(old.options.contextSignal.aborted,true); assert.equal(old.stops,1);
  assert.equal(f.c.getDevice('SYNTHETIC_A'),undefined);
  f.advance(30000); await f.begin(); assert.equal(f.c.getStatus().devices,1);
});
test('late rejection after replacement is absorbed',async()=>{
  const f=fixture(); const late=deferred(); f.accountResult=late.promise;
  f.c.setCredentials(credentials); f.c.start(); const pending=f.c.discover(); await drain();
  f.c.setCredentials({ ...credentials,password:'OTHER' }); assert.equal((await pending).reason,'invalidated');
  late.reject(new Error('SYNTHETIC_PRIVATE')); await drain(); assert.equal(f.lifecycles.length,0);
});
test('one caller cancellation does not abandon shared discovery',async()=>{
  const f=fixture(); const late=deferred(); f.accountResult=late.promise;
  const abort=new AbortController(); f.c.setCredentials(credentials); f.c.start();
  const a=f.c.discover({ signal:abort.signal }),b=f.c.discover(); await drain(); abort.abort();
  assert.equal((await a).reason,'cancelled'); late.resolve(ok(f.account)); assert.equal((await b).ok,true);
});
for(const status of [429,503]) {
  test(status+' cooldown survives clear and credential context replacement',async()=>{
    const f=fixture(); f.accountResult={ ok:false,error:{ kind:status===429?'rate-limited':'http',status,retryAfterMs:120000 } };
    await f.begin(); const n=f.calls.length;
    f.c.clear(); f.c.setCredentials({ ...credentials,password:'OTHER' }); f.c.start();
    assert.equal((await f.c.discover()).reason,'cooldown'); assert.equal(f.calls.length,n);
    f.advance(119999); assert.equal((await f.c.discover()).reason,'cooldown');
    f.advance(1); f.accountResult=undefined; assert.equal((await f.c.discover()).ok,true);
  });
}
test('429 missing guidance uses 60 seconds and stale rate limit cannot affect new context',async()=>{
  const f=fixture(); f.accountResult={ ok:false,error:{ kind:'rate-limited',status:429 } };
  await f.begin(); f.c.clear(); f.c.setCredentials(credentials); f.c.start();
  assert.equal((await f.c.discover()).retryAfterMs,60000);
  f.advance(60000); const late=deferred(); f.accountResult=late.promise;
  const pending=f.c.discover(); await drain(); f.c.clear(); await pending;
  late.resolve({ ok:false,error:{ kind:'rate-limited',status:429,retryAfterMs:900000 } }); await drain();
  f.c.setCredentials(credentials); f.c.start(); f.accountResult=undefined;
  assert.notEqual((await f.c.discover()).reason,'cooldown');
});
test('account UUID change invalidates all devices; fallback ID does not replace trusted provenance',async()=>{
  const f=fixture(); await f.begin(); f.account={ id:'FALLBACK',identitySource:'id' };
  await f.c.discover(); assert.equal(f.lifecycles.length,1);
  f.account={ id:'DIFFERENT_UUID',identitySource:'uuid' }; await f.c.discover();
  assert.equal(f.c.getStatus().phase,'attention-required'); assert.equal(f.c.getStatus().devices,0);
});
test('initial fallback account never grants MQTT',async()=>{
  const f=fixture(); f.account.identitySource='id'; await f.begin(); assert.equal(f.lifecycles.length,0);
});
test('MQTT attention remains diagnostic and rediscovery does not manufacture token recovery',async()=>{
  const f=fixture(); await f.begin();
  f.lifecycles[0].options.onStatus({ phase:'attention-required',connected:false,error:{ kind:'authentication-refused',private:'SYNTHETIC' } });
  await f.c.discover(); assert.equal(f.lifecycles.length,1); assert.equal(f.lifecycles[0].starts,1);
  assert.equal(f.c.getStatus().phase,'attention-required'); assert.doesNotMatch(JSON.stringify(f.c.getStatus()),/SYNTHETIC/);
});
for(const callback of [()=>{
  throw new Error('SYNTHETIC');
},()=>Promise.reject(new Error('SYNTHETIC'))]) {
  test('observer failures do not corrupt ownership',async()=>{
    const f=fixture({ observer:callback }); await f.begin(); assert.equal(f.c.getStatus().devices,1);
  });
}
test('reentrant observer shutdown prevents subsequent GETs',async()=>{
  const f=fixture({ observer:(s,f)=>{
    if(s.phase==='discovering'){
      f.c.stop();
    }
  } });
  await f.begin(); assert.equal(f.calls.includes('account'),false); assert.equal(f.c.getStatus().phase,'stopped');
});
test('reentrant readiness invalidation suppresses first message',async()=>{
  const f=fixture({ observer:(s,f)=>{
    if(s.connections.some(c=>c.status.connected)){
      f.c.invalidate();
    }
  } });
  await f.begin(); f.message(); assert.equal(f.c.getDevice('SYNTHETIC_A'),undefined);
});
test('oversized initial plan creates no lifecycle and does not truncate',async()=>{
  const f=fixture(); f.boxes=Array.from({ length:101 },(_,i)=>box('BOX'+i)); await f.begin(); assert.equal(f.lifecycles.length,0);
});
test('definitive authentication failure requires deliberate clear',async()=>{
  const f=fixture(); f.authResult={ ok:false,error:{ kind:'http',status:401,oauthError:'invalid_grant' } };
  await f.begin(); assert.equal(f.c.getStatus().phase,'attention-required');
  assert.equal(f.c.setCredentials({ ...credentials,password:'OTHER' }).ok,false);
  f.c.clear(); f.authResult=undefined; f.advance(30000); await f.begin(); assert.equal(f.c.getStatus().devices,1);
});
test('actual 5B callback ordering delivers first buffered state before promise settlement',async()=>{
  const f=fixture({ options:{ lifecycleFactory:options=>createMqttLifecycle({ ...options,jitter:()=>0.5,
    transportFactory:callbacks=>({ getStatus:()=>({ phase:'idle' }),close(){},connect:async()=>{
      callbacks.onStatus({ phase:'ready' });
      callbacks.onMessage({ routeId:'SYNTHETIC_A',topic:'external/toniebox/SYNTHETIC_A_MAC/volume/state',
        payload:new TextEncoder().encode('{"level":7}'),retained:true,qos:1,duplicate:false,receivedAtMs:1000 });
      return { ok:true };
    } }) }) } });
  await f.begin(); await drain(); assert.equal(f.c.getDevice('SYNTHETIC_A').state.topics['volume/state'].value.level,7);
});
test('public snapshots are detached and contain no private identifiers',async()=>{
  const f=fixture(); await f.begin(); const status=f.c.getStatus(); status.connections[0].status.phase='stopped';
  assert.equal(f.c.getStatus().phase,'connected'); assert.doesNotMatch(JSON.stringify(f.notices),/SYNTHETIC/);
  f.c.stop(); f.c.stop(); assert.equal(f.c.setCredentials(credentials).reason,'stopped'); assert.equal(f.jobs.size,0);
});

for (const factory of [() => {
  throw new Error('SYNTHETIC_PRIVATE');
}, () => ({})]) {
  test('factory contract failure terminates context and releases token timers', async () => {
    const f = fixture({ options: { lifecycleFactory: factory } });
    await f.begin();
    assert.equal(f.c.getStatus().phase, 'attention-required');
    assert.equal(f.c.getStatus().devices, 0);
    assert.equal(f.jobs.size, 0);
    assert.doesNotMatch(JSON.stringify(f.c.getStatus()), /SYNTHETIC/);
  });
}
test('invalid clock fails safely without dispatching discovery', async () => {
  const f = fixture({ options: { clock: { now: () => ({ monotonicMs: NaN, wallMs: 0 }) } } });
  await f.begin();
  assert.equal(f.calls.length, 0);
  assert.equal(f.c.getStatus().phase, 'attention-required');
});
test('invalid credential replacement does not revoke a healthy context', async () => {
  const f = fixture(); await f.begin();
  assert.equal(f.c.setCredentials({ username:'',password:'bad' }).reason, 'invalid-input');
  assert.equal(f.lifecycles[0].stops, 0);
});
test('scheduler failure is contained by existing token/discovery components', async () => {
  const f = fixture({ options: { scheduler: { schedule() {
    throw new Error('SYNTHETIC');
  } } } });
  const result = await f.begin();
  assert.equal(result.ok, false);
  assert.equal(f.lifecycles.length, 0);
  assert.doesNotMatch(JSON.stringify(f.c.getStatus()), /SYNTHETIC/);
});

for (const terminal of [false, true]) {
  test('rejected stale readiness cannot restore public connection status: ' + terminal, async () => {
    const f = fixture(); await f.begin(); f.message();
    const lifecycle = f.lifecycles[0];
    lifecycle.options.onStatus(terminal
      ? { phase: 'attention-required', connected: false, error: { kind: 'authentication-refused' } }
      : { phase: 'waiting-retry', connected: false, retryAfterMs: 10000 });
    const status = f.c.getStatus();
    const count = f.notices.length;
    lifecycle.options.onStatus({ phase: 'ready', connected: true, session: terminal ? 2 : 1 });
    f.message(lifecycle, 99);
    assert.deepEqual(f.c.getStatus(), status);
    assert.equal(f.notices.length, count);
    assert.equal(f.c.getDevice('SYNTHETIC_A').state.topics['volume/state'].value.level, 4);
    assert.equal(f.c.getDevice('SYNTHETIC_A').freshness['volume/state'], 'last-known');
    assert.equal(f.lifecycles.length, 1);
  });
}


const modelRule = (product, generation, decision) => ({ product, generation, family: 'unknown', decision,
  protocol: 'ici-seven-state-topics', evidence: 'SYNTHETIC_EXPLICIT_PERMISSION' });
const experimentalPolicy = { rules: [modelRule('SYNTHETIC_MODEL', 'SYNTHETIC_GEN', 'experimental')] };
const experiments = count => Array.from({ length: count }, (_, i) => box('EXP_' + i,
  { product: 'SYNTHETIC_MODEL', generation: 'SYNTHETIC_GEN' }));

for (const count of [4, 5, 101]) {
  test('experimental aggregate admission is all-or-nothing at count ' + count, async () => {
    const f = fixture({ options: { policy: experimentalPolicy } });
    f.boxes = [box(), ...experiments(count)]; await f.begin();
    const accepted = count <= 4;
    assert.equal(f.lifecycles.length, accepted ? 5 : 1);
    assert.equal(f.c.getStatus().experimentalAdmission, accepted ? undefined : 'resource-limit');
    assert.equal(f.c.getStatus().phase, 'connected');
    assert.equal(f.c.getStatus().devices, accepted ? 5 : 1);
    for (const lifecycle of f.lifecycles) {
      assert.equal(lifecycle.starts, 1);
      assert.equal(lifecycle.options.routes.length, 1);
    }
    assert.equal(f.c.getStatus().connections.filter(c => c.lane === 'experimental').length, accepted ? 4 : 0);
    assert.doesNotMatch(JSON.stringify(f.notices), /SYNTHETIC|EXP_/);
    f.c.stop(); assert.equal(f.jobs.size, 0);
    assert.ok(f.lifecycles.every(l => l.stops === 1));
  });
}

test('oversized experimental rediscovery suspends every experiment without disturbing production state', async () => {
  const f = fixture({ options: { policy: experimentalPolicy } });
  f.boxes = [box(), ...experiments(4)]; await f.begin(); f.message();
  const production = f.lifecycles[0], previous = f.lifecycles.slice(1);
  const state = f.c.getDevice('SYNTHETIC_A');
  f.boxes = [box(), ...experiments(5)]; await f.c.discover();
  assert.equal(f.lifecycles.length, 5); assert.equal(production.stops, 0);
  assert.equal(production.starts, 1); assert.deepEqual(f.c.getDevice('SYNTHETIC_A'), state);
  assert.ok(previous.every(l => l.stops === 1));
  assert.equal(f.c.getStatus().experimentalAdmission, 'resource-limit');
  const notices = f.notices.length;
  for (const old of previous) {
    old.options.onStatus({ phase: 'ready', connected: true, session: 2 });
    f.message(old, 99);
  }
  assert.equal(f.notices.length, notices); assert.equal(f.c.getDevice('EXP_0', 'experimental'), undefined);
  await f.c.discover(); assert.equal(f.lifecycles.length, 5);
  f.boxes = [box(), ...experiments(4)]; await f.c.discover();
  assert.equal(f.lifecycles.length, 9); assert.equal(production.stops, 0);
  assert.equal(f.c.getStatus().experimentalAdmission, undefined);
  assert.equal(f.c.getStatus().devices, 5);
  f.c.stop(); assert.ok(f.lifecycles.every(l => l.stops === 1)); assert.equal(f.jobs.size, 0);
});

for (const lane of ['production', 'experimental']) {
  for (const field of ['product', 'generation']) {
    test(lane + ' confirmed ' + field + ' change replaces model authority before new messages', async () => {
      const oldIdentity = { product: 'SYNTHETIC_MODEL', generation: 'SYNTHETIC_GEN' };
      const nextIdentity = { ...oldIdentity, [field]: 'SYNTHETIC_CHANGED' };
      const decision = lane === 'production' ? 'validated' : 'experimental';
      const policy = { rules: [modelRule(oldIdentity.product, oldIdentity.generation, decision),
        modelRule(nextIdentity.product, nextIdentity.generation, decision)] };
      const f = fixture({ options: { policy } });
      f.boxes = [box(undefined, oldIdentity)]; await f.begin(); f.message();
      const old = f.lifecycles[0];
      const stop = old.stop.bind(old);
      old.stop = () => {
        stop(); old.options.onStatus({ phase: 'ready', connected: true, session: 2 }); f.message(old, 99);
      };
      f.boxes = [box(undefined, nextIdentity)]; await f.c.discover();
      assert.equal(old.stops, 1); assert.equal(f.lifecycles.length, 2);
      assert.deepEqual(f.c.getDevice('SYNTHETIC_A', lane).state.identity,
        box(undefined, nextIdentity));
      assert.deepEqual(f.c.getDevice('SYNTHETIC_A', lane).state.topics, {});
      f.message(f.lifecycles[1], 7);
      const state = f.c.getDevice('SYNTHETIC_A', lane), status = f.c.getStatus(), notices = f.notices.length;
      old.options.onStatus({ phase: 'attention-required', connected: false, error: { kind: 'authentication-refused' } });
      f.message(old, 99);
      assert.deepEqual(f.c.getDevice('SYNTHETIC_A', lane), state);
      assert.equal(state.state.topics['volume/state'].value.level, 7);
      assert.deepEqual(f.c.getStatus(), status); assert.equal(f.notices.length, notices);
      await f.c.discover(); assert.equal(f.lifecycles.length, 2); assert.equal(f.lifecycles[1].starts, 1);
    });
  }
}

for (const metadata of [{ product: undefined }, { generation: undefined }, { features: undefined }, { features: [] }]) {
  test('optional metadata loss retains trusted production identity: ' + Object.keys(metadata)[0] + JSON.stringify(metadata), async () => {
    const f = fixture(); await f.begin(); f.message();
    const state = f.c.getDevice('SYNTHETIC_A');
    f.boxes = [box(undefined, metadata)]; await f.c.discover();
    assert.equal(f.lifecycles.length, 1); assert.equal(f.lifecycles[0].stops, 0);
    assert.deepEqual(f.c.getDevice('SYNTHETIC_A'), state);
    assert.equal(f.c.getStatus().authority, 'last-known');
  });
}

for (const lane of ['production', 'experimental']) {
  test(lane + ' unapproved new model cannot inherit previous compatibility authority', async () => {
    const f = fixture({ options: { policy: { rules: [modelRule('SYNTHETIC_MODEL', 'SYNTHETIC_GEN',
      lane === 'production' ? 'validated' : 'experimental')] } } });
    f.boxes = [box(undefined, { product: 'SYNTHETIC_MODEL', generation: 'SYNTHETIC_GEN' })]; await f.begin();
    f.boxes = [box(undefined, { product: 'UNAPPROVED_MODEL', generation: 'SYNTHETIC_GEN' })]; await f.c.discover();
    assert.equal(f.lifecycles[0].stops, 1); assert.equal(f.lifecycles.length, 1);
    assert.equal(f.c.getDevice('SYNTHETIC_A', lane), undefined);
  });
}
