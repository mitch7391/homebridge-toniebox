import assert from 'node:assert/strict';
import net from 'node:net';
import { before, after, afterEach, mock, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
let PlatformRuntime, createAccountCoordinator;
let forbidden = 0;
const runtimes = [];
before(async () => {
  const deny = () => {
    forbidden++; throw new Error('Forbidden network/timer');
  };
  mock.method(globalThis, 'fetch', deny); mock.method(net.Socket.prototype, 'connect', deny);
  mock.method(globalThis, 'setTimeout', deny); mock.method(globalThis, 'setInterval', deny);
  ({ PlatformRuntime } = await import('../dist/platformRuntime.js'));
  ({ createAccountCoordinator } = await import('../dist/toniebox/accountCoordinator.js'));
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.stop();
  }
  await turn(); assert.equal(forbidden, 0);
});
after(() => mock.restoreAll());
const credentials = { username: ' SYNTHETIC_USER ', password: ' SYNTHETIC_PASSWORD ' };
const complete = { ok: true, recovery: { disposition: 'none', reason: 'complete', coverage: 'complete' } };
const retry = minimumRetryDelayMs => ({ ok: false, reason: 'discovery', recovery: {
  disposition: 'retry', reason: 'transient', coverage: 'unknown',
  ...(minimumRetryDelayMs === undefined ? {} : { minimumRetryDelayMs }),
} });
const deferred = () => {
  let resolve, reject; const promise = new Promise((a,b) => {
    resolve=a; reject=b;
  }); return { promise, resolve, reject };
};
async function drain() {
  for (let i=0;i<80;i++) {
    await Promise.resolve();
  }
}
function fixture(options = {}) {
  const f = { time: 0, jobs: new Set(), history: [], calls: [], logs: [], result: complete };
  const schedule = (fn, ms) => {
    const job = { fn, ms }; f.jobs.add(job); f.history.push(job);
    return () => {
      f.jobs.delete(job); options.cancel?.();
    };
  };
  const logger = { info: message => {
    f.logs.push(message); return options.log?.(f);
  },
  warn: message => {
    f.logs.push(message); return options.log?.(f);
  } };
  const factory = status => {
    f.calls.push('create'); f.status = status; options.factory?.(f);
    return {
      setCredentials(value) {
        f.credentials = value; f.calls.push('credentials'); options.credentials?.(f); return { ok: true };
      },
      start() {
        f.calls.push('start'); options.start?.(f); return { ok: true };
      },
      discover({ signal }) {
        f.calls.push('discover'); f.signal = signal; options.discover?.(f); return f.result;
      },
      stop() {
        f.calls.push('stop'); options.stop?.(f);
      },
    };
  };
  f.runtime = new PlatformRuntime(options.config === undefined ? credentials : options.config, logger,
    { coordinatorFactory: factory, now: () => f.time, schedule, jitter: () => 0, ...options.dependencies });
  runtimes.push(f.runtime);
  f.fire = () => {
    const job = [...f.jobs][0]; assert.ok(job); f.time += job.ms; job.fn();
  };
  return f;
}
test('construction snapshots credentials without effects; duplicate launch joins exactly once', async () => {
  const config = { ...credentials }; const f = fixture({ config }); config.password='OTHER';
  assert.deepEqual(f.calls, []); assert.equal(f.jobs.size, 0); f.runtime.launch(); f.runtime.launch(); await drain();
  assert.deepEqual(f.calls, ['create','credentials','start','discover']); assert.deepEqual(f.credentials, credentials);
  assert.equal(f.jobs.size, 0); assert.ok(f.logs.includes('Toniebox discovery completed.'));
});
for (const config of [{}, null, [], 'bad', { username:'x' }, { password:'x' }, { username:1,password:'x' },
  { username:'   ',password:'x' }, { username:'x',password:'' }, { username:'x',password:2 },
  { get username() {
    throw new Error('SYNTHETIC');
  } }, { username:'x',get password() {
    throw new Error('SYNTHETIC');
  } }]) {
  test('invalid or missing configuration remains offline: ' + typeof config, () => {
    const f=fixture({ config }); f.runtime.launch(); assert.deepEqual(f.calls, []); assert.equal(f.jobs.size,0);
    assert.doesNotMatch(JSON.stringify(f.logs), /SYNTHETIC/);
  });
}
test('successful partial enumeration logs degraded coverage without polling', async () => {
  const f=fixture(); f.result={ ok:true,recovery:{ disposition:'none',reason:'incomplete',coverage:'partial' } };
  f.runtime.launch(); await drain(); assert.equal(f.jobs.size,0); assert.match(f.logs.join(), /incomplete/);
});
test('bounded backoff never overlaps timers or discovery', async () => {
  const f=fixture(); f.result=retry(); f.runtime.launch(); await drain();
  for (const ms of [30000,120000,300000,900000,900000]) {
    assert.equal(f.jobs.size,1); assert.equal([...f.jobs][0].ms,ms);
    const before=f.calls.length; f.runtime.launch(); assert.equal(f.calls.length,before);
    f.fire(); await drain();
  }
  f.result=complete; f.fire(); await drain(); assert.equal(f.jobs.size,0);
  const count=f.calls.length; f.status({ phase:'retrying',connections:[] }); await drain(); assert.equal(f.calls.length,count);
});
for (const jitter of [0,0.5,1]) {
  test('positive jitter bound ' + jitter, async () => {
    const f=fixture({ dependencies:{ jitter:()=>jitter } }); f.result=retry(); f.runtime.launch(); await drain();
    assert.equal([...f.jobs][0].ms,30000*(1+0.2*jitter));
  });
}
test('server minimum dominates jitter and early callbacks do not dispatch', async () => {
  const f=fixture({ dependencies:{ jitter:()=>1 } }); f.result=retry(120000); f.runtime.launch(); await drain();
  assert.equal([...f.jobs][0].ms,120000); const old=[...f.jobs][0]; old.fn();
  assert.equal(f.calls.filter(x=>x==='discover').length,1); assert.equal(f.jobs.size,1);
  old.fn(); assert.equal(f.jobs.size,1);
});
test('very long deadline uses safe chunks without shortened cooldown', async () => {
  const f=fixture(); f.result=retry(5000000000); f.runtime.launch(); await drain();
  assert.equal([...f.jobs][0].ms,2147483647); f.fire();
  assert.equal([...f.jobs][0].ms,2147483647); f.fire();
  assert.equal([...f.jobs][0].ms,705032706); assert.equal(f.calls.filter(x=>x==='discover').length,1);
  f.result=complete; f.fire(); await drain(); assert.equal(f.calls.filter(x=>x==='discover').length,2); assert.equal(f.jobs.size,0);
});
for (const recovery of [undefined, {}, { disposition:'other' },
  { disposition:'retry',reason:'UNSUPPORTED',coverage:'unknown' },
  { disposition:'retry',reason:'permission',coverage:'unknown' },
  { disposition:'retry',reason:'transient',coverage:'complete' },
  { disposition:'retry',reason:'transient',coverage:'unknown',minimumRetryDelayMs:NaN },
  { disposition:'retry',reason:'transient',coverage:'unknown',minimumRetryDelayMs:Infinity },
  { disposition:'retry',reason:'transient',coverage:'unknown',minimumRetryDelayMs:-1 },
  { disposition:'attention',reason:'permission',coverage:'unknown' },
  { disposition:'attention',reason:'authentication',coverage:'unknown' },
  { disposition:'none',reason:'cancelled',coverage:'unknown' },
  { disposition:'none',reason:'stopped',coverage:'unknown' }]) {
  test('nonretry advice never schedules: ' + JSON.stringify(recovery), async () => {
    const f=fixture(); f.result={ ok:false,reason:'discovery',recovery }; f.runtime.launch(); await drain(); assert.equal(f.jobs.size,0);
  });
}
for (const stage of ['factory','credentials','start','discover']) {
  test('reentrant shutdown during '+stage+' revokes authority before continuing', async () => {
    const f=fixture({ [stage]:f=>f.runtime.stop() }); f.runtime.launch(); await drain();
    assert.equal(f.calls.filter(x=>x==='stop').length,1); assert.equal(f.jobs.size,0);
    if(stage!=='discover') {
      assert.equal(f.calls.includes('discover'),false);
    }
    f.runtime.launch(); assert.equal(f.calls.filter(x=>x==='create').length,1);
  });
}
for (const reject of [false,true]) {
  test('shutdown ignores late discovery '+reject, async () => {
    const f=fixture(),late=deferred(); f.result=late.promise; f.runtime.launch(); f.runtime.stop();
    const count=f.logs.length; assert.equal(f.signal.aborted,true);
    if(reject) {
      late.reject(new Error('SYNTHETIC'));
    } else {
      late.resolve(retry());
    }
    await drain(); f.status({ phase:'connected',connections:[{ lane:'production',status:{ phase:'ready',connected:true } }] });
    f.runtime.stop(); f.runtime.launch(); assert.equal(f.logs.length,count); assert.equal(f.jobs.size,0);
    assert.equal(f.calls.filter(x=>x==='stop').length,1);
  });
}
test('shutdown cancels retry even if cancellation throws and callback runs late', async () => {
  const f=fixture({ cancel:()=>{
    throw new Error('SYNTHETIC');
  } }); f.result=retry(); f.runtime.launch(); await drain();
  const old=[...f.jobs][0]; f.runtime.stop(); old.fn(); assert.equal(f.calls.filter(x=>x==='discover').length,1);
  assert.equal(f.calls.filter(x=>x==='stop').length,1);
});
for (const stage of ['factory','credentials','start','discover','stop']) {
  test('throwing dependency contained: '+stage, async () => {
    const f=fixture({ [stage]:()=>{
      throw new Error('SYNTHETIC_SECRET');
    } }); f.runtime.launch(); await drain(); f.runtime.stop();
    assert.equal(f.jobs.size,0); assert.doesNotMatch(JSON.stringify(f.logs),/SYNTHETIC/);
  });
}
for (const log of [()=>{
  throw new Error('SYNTHETIC');
},()=>Promise.reject(new Error('SYNTHETIC'))]) {
  test('throwing logger cannot prevent ownership or cleanup', async () => {
    const f=fixture({ log }); f.runtime.launch(); await drain(); f.runtime.stop(); assert.equal(f.calls.filter(x=>x==='stop').length,1);
  });
}
for (const dependencies of [ { jitter:()=>NaN }, { jitter:()=>-1 }, { jitter:()=>2 }, { now:()=>NaN },
  { schedule:()=>{
    throw new Error('SYNTHETIC');
  } }, { schedule:()=>null },
  { schedule:fn=>{
    fn();return ()=>{};
  } } ]) {
  test('invalid scheduler clock or jitter fails closed', async () => {
    const f=fixture({ dependencies }); f.result=retry(); f.runtime.launch(); await drain();
    assert.equal(f.calls.filter(x=>x==='discover').length <= 1,true); assert.equal(f.jobs.size,0);
    assert.doesNotMatch(JSON.stringify(f.logs),/SYNTHETIC/);
  });
}
test('regressing clock at retry cannot dispatch', async () => {
  const f=fixture(); f.time=100; f.result=retry(); f.runtime.launch(); await drain(); const job=[...f.jobs][0];
  f.time=99; job.fn(); assert.equal(f.calls.filter(x=>x==='discover').length,1); assert.equal(f.calls.filter(x=>x==='stop').length,1);
});
test('lane diagnostics are private and repeated flaps bounded without log timers', async () => {
  const f=fixture(); f.runtime.launch(); await drain();
  const ready={ phase:'connected',connections:[{ lane:'production',status:{ phase:'ready',connected:true,private:'SYNTHETIC' } }] };
  f.status(ready); f.status(ready);
  f.status({ ...ready,phase:'attention-required',connections:[...ready.connections,
    { lane:'experimental',status:{ phase:'attention-required',connected:false,error:{ private:'SYNTHETIC' } } }] });
  assert.match(f.logs.join(),/production connection established/); assert.match(f.logs.join(),/experimental connectivity requires attention/);
  assert.doesNotMatch(f.logs.join(),/production connection interrupted/);
  for(let i=0;i<100;i++) {
    f.status({ phase:'retrying',connections:[{ lane:'production',status:{ phase:'waiting-retry',connected:false } }] }); f.status(ready);
  }
  assert.equal(f.logs.filter(s=>s.includes('production connection established')).length,1);
  assert.equal(f.logs.filter(s=>s.includes('production connection retrying')).length,1);
  assert.equal(f.jobs.size,0); assert.doesNotMatch(f.logs.join(),/SYNTHETIC/);
});
test('status observer shutdown prevents misleading subsequent notices', async () => {
  const f=fixture({ log:f=>{
    if(f.logs.at(-1).includes('production connection established')) {
      f.runtime.stop();
    }
  } });
  f.runtime.launch(); await drain();
  f.status({ phase:'attention-required',connections:[{ lane:'production',status:{ phase:'ready',connected:true } },
    { lane:'experimental',status:{ phase:'attention-required',connected:false } }] });
  assert.doesNotMatch(f.logs.join(),/experimental/); assert.equal(f.calls.filter(x=>x==='stop').length,1);
});
test('actual coordinator is joined in same turn: one login and one discovery sequence', async () => {
  const calls=[],jobs=new Set();
  const diagnostics={ rejectedEntries:0,degradedEntries:0,duplicateEntries:0,ambiguousRoutingEntries:0,continuationDetected:false };
  const ok=value=>({ ok:true,value,diagnostics });
  const f=fixture({ dependencies:{ coordinatorFactory:onStatus=>createAccountCoordinator({ onStatus,
    clock:{ now:()=>({ monotonicMs:0,wallMs:0 }) },scheduler:{ schedule:(fn,ms)=>{
      const j={ fn,ms };jobs.add(j);return ()=>jobs.delete(j);
    } },
    authClient:{ login:async()=>{
      calls.push('login');return { ok:true,tokens:{ accessToken:'SYNTHETIC',refreshToken:'SYNTHETIC',
        tokenType:'Bearer',expiresInSeconds:300 } };
    },refresh:async()=>{
      throw new Error('Unexpected refresh');
    } },
    discoveryClient:{ getAccount:async()=>{
      calls.push('account');return ok({ id:'SYNTHETIC',identitySource:'uuid' });
    },
    getHouseholds:async()=>{
      calls.push('households');return ok([]);
    },getTonieboxes:async()=>{
      throw new Error('Unexpected boxes');
    } },
  }) } });
  f.runtime.launch(); await drain(); assert.deepEqual(calls,['login','account','households']);
  assert.match(f.logs.join(),/discovery completed/); assert.equal(f.jobs.size,0);
  f.runtime.stop(); assert.equal(jobs.size,0);
});

test('stop before launch remains terminal', () => {
  const f=fixture(); f.runtime.stop(); f.runtime.launch(); assert.deepEqual(f.calls,[]); assert.equal(f.jobs.size,0);
});
test('shutdown reentered by recovery getter cannot log or schedule', async () => {
  const f=fixture(); f.result={ ok:false,get recovery(){
    f.runtime.stop();return retry().recovery;
  } };
  f.runtime.launch(); await drain(); assert.equal(f.jobs.size,0);
  assert.equal(f.logs.at(-1),'Toniebox backend shutdown.'); assert.doesNotMatch(f.logs.join(),/retry scheduled/);
});
test('scheduler reentrant stop cancels newly returned handle', async () => {
  let cancelled=0;
  const f=fixture({ dependencies:{ schedule:()=>{
    f.runtime.stop();return ()=>{
      cancelled++;
    };
  } } });
  f.result=retry(); f.runtime.launch(); await drain(); assert.equal(cancelled,1);
  assert.equal(f.calls.filter(x=>x==='stop').length,1);
});
for (const phase of ['acquiring-token','connecting','ready','waiting-retry']) {
  test('shutdown after MQTT '+phase+' stops backend without rediscovery', async () => {
    const f=fixture(); f.runtime.launch(); await drain();
    f.status({ phase:'connecting',connections:[{ lane:'production',status:{ phase,connected:phase==='ready' } }] });
    f.runtime.stop(); f.runtime.stop();
    assert.equal(f.calls.filter(x=>x==='stop').length,1); assert.equal(f.calls.filter(x=>x==='discover').length,1);
  });
}
