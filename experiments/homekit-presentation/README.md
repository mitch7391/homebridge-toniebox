# Increment 8A: completed synthetic HomeKit presentation research (A-I)

This is an isolated experiment, not production accessory support. It imports no
production modules, authenticates nowhere, creates no MQTT client, publishes no
commands and has no polling, simulation timer or custom control server.

Increment 8A.4 completes the A-I fixture. See [FINDINGS.md](FINDINGS.md) for the
maintainer-reported Apple Home/Siri/Eve results, offline evidence, limitations and
agreed production presentation direction. Production integration is not implemented.

**Approval boundary:** this fixture and research record are ready for independent
review. The retained launch, pairing, restart and cleanup procedures are for
separately authorised manual use; close-out does not authorise running them.
Nothing here installs a plugin or starts a server automatically.

## Design and selectable states

Homebridge loads `index.mjs` through this directory's private package metadata.
The constructor is inert; one launch event constructs one accessory. No build or
npm install is needed. The runtime uses only Homebridge-supplied API/HAP objects.

| Scenario | Publication | Services | Pairing |
| --- | --- | --- | --- |
| A | `publishExternalAccessories` | Primary SmartSpeaker + Battery + AccessoryInformation | Pair the external speaker separately using scenario A's code. Pairing only the empty bridge does not add it. |
| B | `registerPlatformAccessories` | Primary SmartSpeaker + Battery + AccessoryInformation | Pair the scenario B bridge. |
| C | `registerPlatformAccessories` | Primary Battery + AccessoryInformation, category Other | Pair the scenario C bridge. |
| D | `publishExternalAccessories` | Primary SmartSpeaker + linked Battery + AccessoryInformation; playback writes reject | Pair external D. |
| E | `publishExternalAccessories` | D with synthetic native Play/Pause | Pair external E. |
| F | `publishExternalAccessories` | D with Playback Switch; native target writes reject | Pair external F. |
| G | `publishExternalAccessories` | Linked Battery + primary SmartSpeaker + Playback Switch + AccessoryInformation; shared playback controls | Pair external G. |
| H | `publishExternalAccessories` | G plus native synthetic Volume and Mute | Pair external H. |
| I | `publishExternalAccessories` | Primary regular Speaker + linked Battery + Playback Switch + AccessoryInformation; Volume works, mandatory Mute writes reject | Pair external I. |

External accessories are paired separately; their empty bridge needs no pairing.
The table describes fixture contracts, not guaranteed client UI.

All identities are fixed synthetic values and differ between scenarios. One
platform instance is allowed per Homebridge API instance. The storage directory
must end with `toniebox-presentation-A` through `-I`, matching the scenario.
This is an accident-prevention check, not a security boundary against an operator
deliberately loading the fixture in production. Use the strict launch command.

The sample configs whitelist only this fixture, include no other platforms or
accessories, and reserve distinct bridge ports (53181-53189), external port ranges
(53281-53289), bridge identities and pairing codes. Pairing codes are public test
values, not production secrets. Run only one scenario at a time. Do not run copies
of the same scenario concurrently on Windows and a Pi or reuse their identities.

Configuration is a process-instance snapshot. Stop the test process, edit ONLY
its dedicated storage/config.json, then restart with the same storage to select
another state. Do not change scenario in an existing storage directory.

| Field | Allowed values / effect |
| --- | --- |
| fixtureOnly | Must be literal true. |
| scenario | A through I; must match the storage leaf name. |
| playback | playing -> PLAY; paused -> PAUSE; no-media -> STOP internally. Ignored by C. I exposes playback only through its Switch, not native media-state characteristics. |
| battery | charging -> 78%, charging, normal; discharging -> 64%, not charging, normal; low -> 12%, not charging, low; unknown -> unknown data. |
| unavailable | Boolean. true makes state GETs fail with SERVICE_COMMUNICATION_FAILURE. Information metadata remains readable. |

No free-form state payloads, credentials, real identifiers or endpoints are
accepted. Unknown configuration keys fail closed. platform/name are normal
Homebridge metadata; displayed names come from fixed synthetic labels.

### Honest writable and unknown-state contracts

SmartSpeaker retains required CurrentMediaState and writable TargetMediaState.
In A/B/D/F every target write, including one equal to the current synthetic state,
rejects with HAP NOT_ALLOWED_IN_CURRENT_STATE (-70412). E accepts synthetic
Play/Pause target writes. F instead accepts Playback Switch writes; G/H accept both. See the 8A.2
section for these isolated control paths and no-media handling. A/B/D retain a
fixed target/current pair from configuration. ConfiguredName is included for presentation; renames through that
characteristic are also explicitly rejected. Default Homebridge Identify is an
inert acknowledgement; no physical identification action is installed.

Volume and Mute are absent in A-G, including after fixture-cache restoration.
H exposes writable synthetic Volume and Mute; I exposes writable Volume and mandatory, non-operable Mute. AirPlayEnable is always absent.
This is not an AirPlay receiver. A volume slider or AirPlay-like UI drawn by Apple
Home does not establish functioning native volume writes or streaming support.

With unknown battery, optional BatteryLevel and ChargingState are absent. The
required StatusLowBattery GET returns SERVICE_COMMUNICATION_FAILURE (-70402), not
normal or zero. If a host HAP version requires either of the other fields, they
remain present with unavailable GETs rather than removing required characteristics.
The tests validate the installed definitions and a required-field compatibility seam;
that seam is not execution on an older Homebridge release.

Unknown is not represented as 0%, not-chargeable, stopped or paused. Unavailable
preserves the known-profile characteristic layout but errors on state reads.
Underlying HAP cached/default values are not valid observations when GET fails.
Apple Home may retain old displays or show persistent No Response. That behaviour
must be measured; no immediate recovery or tile visibility is promised.

Battery-only has the expected HAP service/required-characteristic structure and
can be constructed, registered through the API and serialised offline. That does
not prove actual publication, pairing, certification or Apple Home UI usability.

## Ownership, restoration and shutdown

B/C restore only the exact synthetic UUID and fixture context, reattach handlers,
replace preset values, and update the existing accessory instead of registering
a duplicate. Removed optional fields are removed from restored services.
An unexpected cache stops new fixture publication with a fixed diagnostic; use
fresh dedicated storage rather than repairing an unfamiliar cache automatically.

A/D/E/F/G/H/I reconstruct their deterministic external accessory each process start. They do
not pretend that external publication participates in bridged configureAccessory
restoration or platform cache removal.

Shutdown is terminal and idempotent. It removes fixture launch/shutdown listeners,
rejects later state reads and target writes, and never unregisters cached devices.
Homebridge owns publication, sockets and advertising teardown when its isolated
process exits. The fixture does not call private unpublish/destroy APIs. Calling
fixture.stop() alone is not a supported way to unpublish an external accessory.
Logger exceptions/rejections cannot reopen the fixture. No global debug settings
are changed.

## Offline validation (safe now)

Use the already installed Homebridge dependency tree; do not install packages.
For this worktree, in PowerShell:

```powershell
$worktree = 'C:\Users\mitch\Projects\homebridge-toniebox-increment-8a1'
$env:HOMEBRIDGE_FIXTURE_DEPENDENCIES = 'C:\Users\mitch\Projects\homebridge-toniebox\node_modules\homebridge'
Set-Location -LiteralPath $worktree
node --test --test-reporter=spec experiments/homekit-presentation/test/fixture.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Fixture tests failed' }
```

The override selects installed test dependencies, not production source/config.
Without it, the tests resolve Homebridge from normal installed node_modules.
The fixture itself has no dependency imports.

Tests use real HAP classes, real Homebridge registration methods and the actual
bridged cache serialiser, with no BridgeService/server attached. Test-only imports
of Homebridge internal modules exercise those seams; production fixture code uses
only the supplied public API. Network/listen/HTTP/datagram/polling attempts are
independently counted outside fixture exception boundaries. HAP's inert one-second
configuration debounce is driven by a controlled scheduler, not a wall-clock sleep.
Mocks are restored in finally cleanup and late work is audited before restoration.

The reviewed local test environment is Windows Node.js 24.19.0, Homebridge 2.4.0,
HAP 2.2.2. The complete fixture suite reports 122 passing tests. No Linux, Node.js 22
or Homebridge 1.x validation is implied. Manual client results are separately
labelled in [FINDINGS.md](FINDINGS.md); offline tests cannot establish UI behaviour.
The metadata retains the project's declared runtime ranges; choose a Homebridge
release whose own Node engine range also supports the selected Node version.
Homebridge 1.8.0's API availability does not imply Node.js 22/24 engine support.

## Original A/B/C Windows manual experiment — separate approval required

Do not install globally, use npm link, invoke hb-service, or alter production
Homebridge's config, plugins, storage or service. Use a foreground test process.

1. Choose A, B or C. Create a NEW storage directory only for that scenario.
2. Copy the sample only on first setup. Refuse to overwrite existing storage.
3. Check that chosen ports are free, and that no other copy of this synthetic
   scenario is running on the LAN.
4. Ensure verbose dependency tracing is not enabled in this shell.
5. Launch the existing Homebridge executable with strict plugin resolution.

```powershell
$scenario = 'A' # Run B and C separately after stopping A.
if ($scenario -notin @('A', 'B', 'C')) { throw 'Invalid scenario' }
$fixture = 'C:\Users\mitch\Projects\homebridge-toniebox-increment-8a1\experiments\homekit-presentation'
$homebridgePackage = 'C:\Users\mitch\Projects\homebridge-toniebox\node_modules\homebridge'
$storage = Join-Path $env:LOCALAPPDATA ('TonieboxPresentation\toniebox-presentation-' + $scenario)
if (Test-Path -LiteralPath $storage) { throw 'Storage exists: use the restart procedure; do not overwrite it' }
if ($env:DEBUG) { throw 'Use a separate shell without dependency DEBUG tracing' }
New-Item -ItemType Directory -Path $storage | Out-Null
Copy-Item -LiteralPath (Join-Path $fixture ('config-' + $scenario + '.json')) -Destination (Join-Path $storage 'config.json')
$configuration = Get-Content -Raw -LiteralPath (Join-Path $storage 'config.json') | ConvertFrom-Json
$occupied = Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in @($configuration.bridge.port, $configuration.ports.start) }
if ($occupied) { throw 'A proposed test port is already in use; do not start' }
$cli = Join-Path $homebridgePackage 'bin\homebridge.js'
if (-not (Test-Path -LiteralPath $cli)) { throw 'Review the installed Homebridge CLI layout before continuing' }
node $cli -U $storage -P $fixture --strict-plugin-resolution
```

The final line starts local HAP/mDNS services and is NOT authorised by the current
close-out task. It is retained for a separately approved manual experiment.
The dedicated bridge may be empty in A; select the separately advertised synthetic
speaker in Home -> Add Accessory -> More Options. B/C are added through their
dedicated bridge. Never pair the real production Homebridge for this experiment.

### State changes and restart persistence

Press Ctrl+C in the test foreground console and wait for process exit.
Keep storage, pairing and scenario unchanged. Edit only the copied config:

```powershell
notepad (Join-Path $storage 'config.json')
# Change playback, battery or unavailable; save, then:
node $cli -U $storage -P $fixture --strict-plugin-resolution
```

For unavailable, start with known data, restart with unavailable=true, observe,
then restart with unavailable=false. Also test battery=unknown independently.
Do not recopy a sample over paired storage. Restart-based state changes test
presentation/restoration, not live MQTT delivery or real-time device operation.

## Scenarios A-F: original observations and fixture contracts

The maintainer paired A/B/C in Apple Home and reported the following. These are
manual observations, not results established by the offline tests:

| Scenario | Reported Apple Home behaviour |
| --- | --- |
| A | External speaker: Speakers & TVs, speaker icon and Paused state; "Controls not available", grey media/volume controls, no battery fields in inspected screens. |
| B | Bridged speaker: Other, generic house icon, Not Supported tile; Paused and 64% / Charging No visible in details. |
| C | Bridged battery: Other, Not Supported tile; 64% / Charging No visible, no useful primary controls. |

Record iOS and Homebridge versions with subsequent observations. These results do
not establish universal Apple Home behaviour. The close-out findings record the
later maintainer reports without inventing individual D-H client/version results.
No manual experiments are run during documentation close-out.

| Scenario | Difference from A | Writable synthetic control |
| --- | --- | --- |
| D | Battery explicitly linked from SmartSpeaker using addLinkedService; both already belong to the same accessory. | None; TargetMediaState writes reject. |
| E | Same linked services as D. | TargetMediaState PLAY/PAUSE updates synthetic CurrentMediaState and TargetMediaState. STOP and malformed commands reject. |
| F | Same linked services as D plus one native Switch named Playback. | Switch On=true plays, false pauses; SmartSpeaker TargetMediaState writes still reject. |

E/F apply only an in-memory transition and emit HAP characteristic updates before
acknowledging success. They neither command a device nor confirm physical playback.
All other presets remain available. Restart restores the selected playback preset.
For no-media, E/F reject playback changes until restarted with a playing/paused
preset. F's Switch GET fails instead of presenting no-media as Off. With unavailable,
state GETs and synthetic control writes fail. Unknown battery never becomes 0%.

Write diagnostics use fixed received/applied/rejected categories, bounded to 32
write notices per process instance. No supplied values are logged. A received
notice alone does not mean a transition succeeded. After the budget is exhausted,
controls continue to work but no further write notices appear. Shutdown revokes
writes, including shutdown reentered through a characteristic or logger callback.

## Scenarios G/H: combined playback and native volume

G combines E's native TargetMediaState control and F's Playback Switch on one
external SmartSpeaker. H adds the installed HAP definition's native Volume and
Mute characteristics to that SmartSpeaker. Both retain the linked Battery service.

There is one authoritative playback value. Each accepted Play/Pause or Switch
write updates CurrentMediaState, TargetMediaState and Switch.On before success.
G/H use HAP's public callback-style setter so the shared write guard remains active
through HAP's own synchronous cache update and notification. This prevents an
older asynchronous setter completion from overwriting a newer cross-control
transition. E/F retain their existing handlers and isolated control paths.

H starts at volume 50 and mute false. Volume accepts integer percentages 0-100;
Mute accepts booleans at the fixture callback boundary. The host HAP layer validates
and may normalise wire values before invoking callbacks (for example boolean
characteristics' 0/1 representation). Both characteristics retain the installed
read/write/notify permissions. Mute never erases the selected volume, changing
volume does not unmute, and neither changes playback. With no-media, volume/mute
preferences may change while playback remains STOP and the Switch read remains
unavailable. Unknown playback presets remain invalid. Unavailable or stopped
fixtures reject audio reads and writes.

All changes are synthetic and in memory. Restart restores the configured playback
preset, volume 50 and mute false. There is no audio output, AirPlay advertisement,
volume-command proxy or physical-device confirmation. No Lightbulb or Television
service is introduced.

The existing 32-notice write budget is shared by playback, volume and mute, rather
than expanded per control. Fixed "Synthetic media/switch/volume/mute write received."
and "Synthetic ... transition applied." notices distinguish received HAP writes
from UI changes. Invalid requests rejected by HAP before the fixture callback may
produce no fixture notice. Absence of notices after exhaustion of the budget is
not evidence of missing writes; restart the isolated process to begin a new
observation session, preserving storage and pairing.

### G manual checklist

1. Pair the external Synthetic Toniebox G; do not pair its empty bridge.
2. Toggle Playback On/Off and observe the speaker state.
3. Issue native SmartSpeaker Play/Pause through HomeKit scenes. Confirm a media
   write-received notice followed by an applied notice; do not infer execution
   solely from a scene's options or animation.
4. Confirm Switch and speaker remain synchronised in both directions.
5. Try Siri controlling the Playback Switch; record the exact synthetic intent
   and whether a switch write actually reached the fixture.
6. Check battery fields in Eve and record Apple Home separately.
7. Stop/restart only the isolated instance using existing storage; check pairing,
   identity, preset restoration and absence of duplicate tiles.

### H manual checklist

1. Repeat every G playback check with Synthetic Toniebox H.
2. Record whether Apple Home displays a native volume slider and whether changing
   it produces a volume write-received/applied pair.
3. Try Siri volume adjustments, native speaker-volume scenes and Eve volume
   reads/writes. Record each independently; Home scene volume options may control
   a different media path and do not prove a native HAP write.
4. Toggle Mute and verify that reading Volume still returns its previous setting.
   Change volume while muted, then unmute; confirm the new setting is retained.
5. Check playback still works before, during and after volume/mute changes.
6. Record hidden or disabled controls as findings. Do not add services, advertise
   AirPlay or change accessory categories to force visibility.

Record iOS, Eve, Homebridge, HAP, Node and home-hub versions with observations.
No G/H UI, Siri, scene, Eve or pairing result is established by offline tests.
See [FINDINGS.md](FINDINGS.md) for the separately reported manual outcomes.

## Scenario I: regular Speaker comparison (Increment 8A.4 complete)

Scenario I is an external accessory with primary Service.Speaker, linked Battery,
Playback Switch and AccessoryInformation. Unlike H, it has no SmartSpeaker,
CurrentMediaState, TargetMediaState, Active, Television, Lightbulb or AirPlay
functionality. Playback is exposed only by the switch: On=Playing, Off=Paused.
The default preset is Paused; no-media remains unavailable rather than false.

Volume starts at 50%, accepts integer percentages 0-100 and emits HAP notifications.
It uses the existing synchronous guarded acknowledgement mechanism independently
of playback. All values are synthetic, reset on process restart, and confirm no
physical action. Unavailable/shutdown protections and bounded write logging apply.

**Mandatory Mute limitation:** regular Speaker requires a writable Mute
characteristic in HAP. I reports a known synthetic non-muted value (false), but
rejects every mute operation, including false, with NOT_ALLOWED_IN_CURRENT_STATE.
It never changes volume to emulate mute. Unavailable/stopped reads and writes
report SERVICE_COMMUNICATION_FAILURE. Apple Home may nevertheless show a mute
button; that does not establish a supported Toniebox operation.

### I manual checklist — compare directly with H

Use the validated Windows procedure below with scenario I, in its own storage.
Pair only the external **Synthetic Toniebox I**, not the empty bridge.

- Does Apple Home place it under Speakers & TVs and show a useful speaker tile?
- Is Playback visible and directly usable? Do On/Off produce switch received and
  applied notices? There is no native media-state characteristic in this scenario.
- Is native volume directly adjustable in Apple Home?
- Does Siri recognise volume requests, and do they actually reach the fixture?
- Can a scene set volume? Confirm a volume received/applied log pair rather than
  assuming that a scene's displayed media options execute native HAP writes.
- Can Eve read and write the regular Speaker Volume?
- Is Battery Level/Charging visible in Apple Home or Eve?
- Are unsupported mute controls displayed? Confirm rejection leaves volume and
  playback unchanged; do not reinterpret rejection as successful physical mute.
- Does restart preserve pairing/identity and restore the configured presets?
- Record differences from H, including hidden controls, icons and service grouping.

Record iOS, Eve, Homebridge, HAP and home-hub versions. Logs remain fixed categories
with a shared 32-write-notice budget; restart the isolated process if more evidence
is needed, preserving storage. No UI outcome is established by offline tests.
The maintainer's regular Speaker results are recorded in [FINDINGS.md](FINDINGS.md).

### Windows D/E/F/G/H/I procedure — separate launch approval required

Run only one isolated scenario at a time, with no other copy on the LAN.
The script below validates paths, all reserved A-I TCP ports, exact configuration
shape and fixed identities **before writing storage**. It does not install anything.
Use a fresh PowerShell window and the existing installed Homebridge CLI.

| Scenario | Bridge identity | Bridge / external port | Public test pairing code |
| --- | --- | --- | --- |
| D | 02:8A:10:00:00:04 | 53184 / 53284 | 795-46-218 |
| E | 02:8A:10:00:00:05 | 53185 / 53285 | 826-57-319 |
| F | 02:8A:10:00:00:06 | 53186 / 53286 | 937-68-421 |
| G | 02:8A:10:00:00:07 | 53187 / 53287 | 518-73-629 |
| H | 02:8A:10:00:00:08 | 53188 / 53288 | 629-84-731 |
| I | 02:8A:10:00:00:09 | 53189 / 53289 | 741-95-832 |

These are synthetic test identities and codes. Do not use production storage or
copy any production configuration. The external accessory UUID is also distinct
for each scenario. Homebridge derives its external pairing identity from that UUID.

Copy the following setup into the approved test shell. Set only $scenario to D,
E, F, G, H or I. Do not run the final launch command before maintainer authorisation.

```powershell
$ErrorActionPreference = 'Stop'
$scenario = 'I' # Other scenarios are separate runs with separate storage.
if ($scenario -cnotin @('D', 'E', 'F', 'G', 'H', 'I')) { throw 'Invalid scenario' }
$fixture = 'C:\Users\mitch\Projects\homebridge-toniebox-increment-8a1\experiments\homekit-presentation'
$homebridgePackage = 'C:\Users\mitch\Projects\homebridge-toniebox\node_modules\homebridge'
$cli = Join-Path $homebridgePackage 'bin\homebridge.js'
$sample = Join-Path $fixture ('config-' + $scenario + '.json')
if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { throw 'Local app-data path unavailable' }
$storage = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA ('TonieboxPresentation\toniebox-presentation-' + $scenario)))
foreach ($path in @($cli, $sample, (Join-Path $fixture 'index.mjs'), (Join-Path $fixture 'package.json'))) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Required reviewed fixture or CLI file missing' }
}
Get-Command node -CommandType Application -ErrorAction Stop | Out-Null
$package = Get-Content -Raw -LiteralPath (Join-Path $fixture 'package.json') | ConvertFrom-Json
if ($package.name -cne 'homebridge-toniebox-presentation-fixture' -or $package.main -cne 'index.mjs' -or $package.private -ne $true) {
  throw 'Unexpected fixture package'
}
$expected = @{
  D = @('02:8A:10:00:00:04', 53184, 53284, '795-46-218')
  E = @('02:8A:10:00:00:05', 53185, 53285, '826-57-319')
  F = @('02:8A:10:00:00:06', 53186, 53286, '937-68-421')
  G = @('02:8A:10:00:00:07', 53187, 53287, '518-73-629')
  H = @('02:8A:10:00:00:08', 53188, 53288, '629-84-731')
  I = @('02:8A:10:00:00:09', 53189, 53289, '741-95-832')
}
function Assert-Keys($value, [string[]]$keys) {
  if ($null -eq $value -or $value -isnot [pscustomobject]) { throw 'Expected configuration object' }
  $actual = @($value.PSObject.Properties.Name)
  if ($actual.Count -ne $keys.Count -or @(Compare-Object $actual $keys -CaseSensitive).Count) {
    throw 'Unexpected configuration fields'
  }
}
function Assert-PresentationConfig([string]$path) {
  $c = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
  Assert-Keys $c @('bridge', 'plugins', 'accessories', 'platforms', 'ports')
  Assert-Keys $c.bridge @('name', 'username', 'port', 'pin')
  Assert-Keys $c.ports @('start', 'end')
  if ($c.plugins -isnot [array] -or $c.plugins.Count -ne 1 -or $c.plugins[0] -cne 'homebridge-toniebox-presentation-fixture' -or
      $c.accessories -isnot [array] -or $c.accessories.Count -ne 0 -or
      $c.platforms -isnot [array] -or $c.platforms.Count -ne 1) { throw 'Unexpected plugins or platforms' }
  $p = $c.platforms[0]
  Assert-Keys $p @('platform', 'name', 'fixtureOnly', 'scenario', 'playback', 'battery', 'unavailable')
  $e = $expected[$scenario]
  foreach ($number in @($c.bridge.port, $c.ports.start, $c.ports.end)) {
    if ($number -isnot [int] -and $number -isnot [long]) { throw 'Port must be an integer' }
  }
  if ($c.bridge.name -cne ('Synthetic Toniebox ' + $scenario) -or $c.bridge.username -cne $e[0] -or
      $c.bridge.port -ne $e[1] -or $c.bridge.pin -cne $e[3] -or $c.ports.start -ne $e[2] -or $c.ports.end -ne $e[2] -or
      $p.platform -cne 'TonieboxPresentationFixture' -or $p.name -cne ('Synthetic Toniebox ' + $scenario) -or
      $p.fixtureOnly -isnot [bool] -or -not $p.fixtureOnly -or $p.scenario -cne $scenario -or
      $p.playback -cnotin @('playing', 'paused', 'no-media') -or $p.battery -cnotin @('charging', 'discharging', 'low', 'unknown') -or
      $p.unavailable -isnot [bool]) { throw 'Unexpected scenario configuration' }
}
function Assert-TestPortsFree {
  if ($env:DEBUG) { throw 'Use a separate shell without dependency DEBUG tracing' }
  $reserved = @(53181..53189) + @(53281..53289)
  $listeners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -in $reserved })
  if ($listeners.Count) { throw 'A reserved test port is occupied; do not kill another process' }
}
# Inspect every reserved sample; identities and ports must remain distinct.
$allConfigs = foreach ($letter in @('A','B','C','D','E','F','G','H','I')) {
  $path = Join-Path $fixture ('config-' + $letter + '.json')
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Scenario sample missing' }
  Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
}
foreach ($field in @('username', 'pin')) {
  if (@($allConfigs | ForEach-Object { $_.bridge.$field } | Sort-Object -Unique).Count -ne 9) { throw 'Conflicting test identities' }
}
$allPorts = @($allConfigs | ForEach-Object { $_.bridge.port; $_.ports.start })
if (@($allPorts | Sort-Object -Unique).Count -ne 18) { throw 'Conflicting test ports' }
Assert-PresentationConfig $sample
Assert-TestPortsFree
if (Test-Path -LiteralPath $storage) { throw 'Storage exists: use restart procedure; do not overwrite' }
New-Item -ItemType Directory -Path $storage -ErrorAction Stop | Out-Null
[IO.File]::Copy($sample, (Join-Path $storage 'config.json'), $false)
Assert-PresentationConfig (Join-Path $storage 'config.json')
Assert-TestPortsFree
# Only after separate approval: this starts Homebridge and real HAP/mDNS.
node $cli -U $storage -P $fixture --strict-plugin-resolution
```

Pair **Synthetic Toniebox D**, **E**, **F**, **G**, **H** or **I** from Apple Home > Add Accessory >
More Options, using that scenario's code. Pair the external accessory, not the
empty bridge. The empty bridge does not need separate pairing. Do not pair or
modify the production Homebridge bridge.

For each new scenario, run the entire setup in a fresh shell with its own letter.
If a check fails, stop and inspect; do not bypass strict resolution or change ports
to work around the check. Port checks reduce accidental collisions, but cannot
reserve a port against another process starting between the check and launch.

### D/E/F observation checklists

Record the scenario, preset, iOS, home hub, Node, Homebridge and HAP versions:

- **D:** Is Battery Level visible in accessory details? Is Charging visible? Does
  linking differ from A? Test discharging, charging, low and unknown separately.
  Media writes must still reject.
- **E:** Are native Play/Pause controls enabled? Does pressing them emit a synthetic
  write-received notice and then an applied notice? Does the displayed state change?
  If controls remain disabled, record that outcome; it does not establish faulty
  callbacks. Do not add volume/AirPlay support to force a different result.
- **F:** Is Playback a separate tile, an accessory-details control, or hidden?
  Can it be toggled directly? Does On show Playing and Off show Paused on the speaker?
  Is it associated with the speaker? Is battery still accessible? Record one tile,
  multiple tiles or hidden services. Do not add another accessory type if hidden.
- **All:** Check unknown/unavailable behaviour and recovery after restart. Do not
  treat cached Home displays as successful GETs or physical-device confirmation.

No Apple Home presentation is guaranteed by service linking or correct HAP writes.

### D/E/F/G/H/I restart and cleanup

Press Ctrl+C and wait for the foreground process to exit. Preserve its directory.
To change a preset, edit only its copied config, then reuse the validation functions
from the setup shell before relaunching:

```powershell
notepad (Join-Path $storage 'config.json')
Assert-PresentationConfig (Join-Path $storage 'config.json')
Assert-TestPortsFree
node $cli -U $storage -P $fixture --strict-plugin-resolution
```

Do not change the scenario, identity, ports or pairing code in existing storage.
Do not recopy samples or overwrite any previous scenario's storage. In-memory
E/F/G/H/I writes are not persisted and reset to the selected preset on restart.
H resets volume/mute to 50/false; I resets volume to 50 and remains non-muted.
The fixture does not expose
a config editor, polling endpoint or automatic playback timer.

For removal, remove only the selected synthetic external accessory from Apple
Home, then Ctrl+C and verify process exit and free reserved ports. If the empty
test bridge was also paired, remove it separately. Preserve storage for repeat
tests. The exact-path archive procedure in "Safe manual teardown" below also
applies to D/E/F/G/H/I: archive only the selected dedicated directory after removal and
shutdown. It renames rather than deletes storage; leave all previous scenarios
and the production Homebridge untouched.


## Proposed Raspberry Pi procedure — not executed, separate approval required

Prefer a disposable test host. If using the existing Pi later, do not stop, edit or
reuse production Homebridge storage or its service. First approve how to transfer
only this experiment directory and verify its hash. No transfer is authorised now.

The following shell procedure assumes the reviewed directory is already available
at ~/toniebox-presentation-fixture and a compatible Homebridge installation already
exists. It installs nothing and must run as the normal test user, not sudo.

```sh
scenario=A
case "$scenario" in A|B|C) ;; *) echo "Invalid scenario"; exit 1 ;; esac
fixture="$HOME/toniebox-presentation-fixture"
storage="$HOME/toniebox-presentation-tests/toniebox-presentation-$scenario"
[ -d "$fixture" ] || { echo "Reviewed fixture missing"; exit 1; }
[ ! -e "$storage" ] || { echo "Storage exists; do not overwrite"; exit 1; }
[ -z "${DEBUG:-}" ] || { echo "Use a shell without DEBUG tracing"; exit 1; }
command -v homebridge >/dev/null || { echo "Existing Homebridge required; do not install here"; exit 1; }
# Inspect 'ss -ltn' and ensure the selected 53181/53281 (A),
# 53182/53282 (B), or 53183/53283 (C) ports are free before continuing.
mkdir -p "$storage"
cp "$fixture/config-$scenario.json" "$storage/config.json"
homebridge -U "$storage" -P "$fixture" --strict-plugin-resolution
```

For restarts, retain this directory, edit its config while stopped, and repeat only
the final launch command. Never run the same scenario simultaneously on Windows
and the Pi: its deterministic external accessory identity would collide.
Use a foreground session and Ctrl+C; no system service or daemon is introduced.

## Manual observation sheet

Record exact Homebridge, HAP, Node.js, OS, iOS and home-hub model/software versions,
scenario, publication mode and synthetic preset. Check actual installed versions;
the fixture FirmwareRevision describes the fixture, not Toniebox firmware.

For each scenario record observed / absent / unsupported / untested:

- Discovery, pairing and correct speaker/other category.
- Tile presence, name, room assignment and useful controls.
- Battery percentage, charging display and low-battery indication.
- Playing, paused and no-media presentation for SmartSpeaker; I has Switch-only playback.
- A/B/D/F target writes fail explicitly; E/F/G/H synthetic controls follow their separate contracts.
- Scene/automation/Siri availability: do not infer support from HAP properties.
- Volume UI: A-G have no volume control; H's volume/mute are synthetic only; I has synthetic volume and rejects mute.
- Unknown battery, unavailable values, persistent No Response and subsequent recovery.
- Restart preserves identity/pairing; B/C do not duplicate registration.
- External A/D/E/F/G/H/I restart behaves correctly without a bridged cache assumption.
- Battery-only is useful or not useful without adding a fake service.
- Safe removal and clean re-pairing in dedicated storage.

Do not record real identifiers, credentials, device names or raw production logs.
Keep only synthetic screenshots and version-qualified findings. Do not generalise
historical/current observations to all future Apple Home versions.

## Safe manual teardown — after the approved presentation test

1. In Apple Home remove only the synthetic accessory/bridge added for this test.
   A/D/E/F/G/H/I external speakers are independently paired: removing an empty bridge is not
   a substitute for removing the speaker. Remove both if both were paired.
2. Stop only the foreground test Homebridge with Ctrl+C and verify it has exited.
   No broad process-kill commands or production service changes.
3. Confirm the chosen test ports are no longer listening. Do not delete storage
   while that process is running.
4. Preserve storage when testing restart persistence. For a clean re-pairing after
   removal, archive ONLY the known dedicated scenario directory. Never delete
   ~/.homebridge, production persist/accessories, or individual unknown pairing files.
5. Leave the experiment source/worktree intact for review; do not clean Git worktrees.

Optional PowerShell archive step, only after steps 1-3:

```powershell
$expected = Join-Path $env:LOCALAPPDATA ('TonieboxPresentation\toniebox-presentation-' + $scenario)
$resolved = (Resolve-Path -LiteralPath $storage).Path
if ($resolved -ne [System.IO.Path]::GetFullPath($expected)) { throw 'Unexpected storage path; stop' }
$archivedName = 'toniebox-presentation-' + $scenario + '-archived-' + [guid]::NewGuid().ToString('N')
Rename-Item -LiteralPath $resolved -NewName $archivedName
```

On a Pi, similarly inspect the exact resolved dedicated storage path and archive
that directory only after stopping its process and removing its test pairing.
Do not use shared cache deletion as an external accessory removal API.
No programmatic external-unpublish or destructive cleanup operation is implemented.
