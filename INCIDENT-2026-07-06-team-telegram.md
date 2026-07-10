# Incidens: a csapat (sub-ágensek) elérhetetlen Telegramon

- Dátum: 2026-07-06, ~05:50-07:40 UTC (07:50-09:40 CEST)
- Író: Orin (friss session, a reggeli v1.19.0 sync utáni utóhatás vizsgálata)
- Tünet: Norbi közvetlenül írt Dexnek és Novának Telegramon, de a csapat
  (atlas/dex/iris/nova) SEMMIRE nem reagált kb. 2 órán át. Orin (fő ágens)
  csatornája végig működött.

## Rövid összefoglaló

A reggeli v1.19.0 upstream-sync + deploy során a futó telepítés elveszítette a
sub-ágensek megbízható Telegram-inbound rétegét (a "pull-modell": stdio tee +
inbox drain hook). Emiatt a channel-plugin watchdog azt hitte, a plugin
folyamatosan halott, és 2 percenként, rotálva RESTARTOLTA az ágenseket. Minden
restart kiütötte a session-kontextusukat és megölte amin dolgoztak, így nem
reagáltak. Norbi üzenetei egy olyan queue-fájlba (`inbox-pending.jsonl`) kerültek,
amit a jelenlegi build semmilyen éles kód nem olvas ki -> néma elnyelés.

A crash-loop NEM végtelen: a watchdognak van egy 5-próbás cap-je ágensenként,
ami után "feladja" és nem indít újra (tartósan). Ezért az ágensek maguktól
stabilizálódtak (atlas/dex/iris elérte a capet), Codex pedig plain `claude`
processként újraindította őket, ami szintén megállította a crasht -- de channel
nélkül nincs reply-eszközük, tehát válaszolni sem tudnak.

## Gyökér-ok (bizonyítva)

A sub-ágens inbound pull-modell három futásidejű darabból áll, amiket a
`4f7ae81` commit tett a lemezre:
- `scripts/channel-inbound-tee.mjs` -- a `--channels` plugin stdout-ját csapolja,
  a bejövő `notifications/claude/channel` frame-eket `inbox-pending.jsonl`-be írja
- `scripts/hooks/channel-inbox-drain.py` (a VALÓDI, 198-soros verzió) -- minden
  ágens-fordulónál kiolvassa a queue-t és visszainjektálja a kontextusba, így a
  flaky plugin ellenére is MEGBÍZHATÓAN megérkezik a bejövő üzenet
- `templates/settings.json.template` -- bedrótozza a drain hookot minden ágens
  `UserPromptSubmit` láncába

Git-régészet:
- `e08207e` (a pull-modell draftja) BENNE van a `develop`-ban (PR #13, `54bcecb`).
- `4f7ae81` (a runtime fájlokat lemezre tevő "persist" commit) **NINCS a
  develop-ban** -- egy külön live branchen (`chore/persist-ops-scripts-and-dex-perms`)
  maradt. Ismert minta: a nem-verziózott ops-fájlok kihullanak (lásd
  `untracked-hooks-fragility`, `update-overwrites-local-fix` memóriák).
- A futó munkafa a `feat/norbull-fleet-v2` @ `a163eaa` branchen áll, ami a TISZTA
  upstream v1.19.0 release-vonal -- NEM tartalmazza a mi custom munkánkat sem
  (opus-escalation, reply-guard, context-clean, stuck-detection, tick-cap mind
  csak develop-ban).

A lemezen jelenleg:
- `scripts/channel-inbound-tee.mjs`: HIÁNYZIK
- `scripts/hooks/channel-inbox-drain.py`: rossz -- egy 82-soros symlink a
  fő-ágens-only `inbox-drain.py`-ra (ami sub-ágensre azonnal `exit 0`-val kilép,
  tehát semmit nem drainel)
- Az ágensek `--channels` FLAG NÉLKÜL futnak (Codex plain-restartja) -> nincs
  reply-eszközük

Következmény: a plugin-liveness-probe (`hasChannelPluginAlive`) "down"-t lát ->
`channel-monitor.ts` restartol -> a pull-modell hiánya miatt sosem lesz stabil ->
loop, amíg a cap le nem áll.

## Idővonal (a dashboard.log alapján, CEST)

- 07:52-07:53 -- Norbi ír Dexnek ("Szia.. Megnézed Dex-et?") és Novának
  ("Szia.. Te itt vagy?"). Az üzenetek `inbox-pending.jsonl`-be kerülnek, de a
  drain nem viszi tovább (rossz symlink) -> néma.
- 08:46-09:25 -- ismétlődő "Agent channel plugin down -- auto-restarting" WARN-ok,
  rotálva iris/atlas/dex/nova. Minden ~2 perc egy ágenst megöl+újraindít.
- 09:14 / 09:16 / 09:25 -- atlas/dex/iris eléri a max restart capet
  ("giving up, alerting operator"), failure-counter 6-ra ugrik -> onnantól nem
  restartolja őket (tartós skip).
- ~09:00-09:16 -- Codex plain `claude`-ként újraindítja az ágenseket (crash
  megáll, de channel nélkül).
- 09:2x -- Orin (ez a session) diagnosztizál, stabil állapotot rögzít.

## Mi állította meg a crasht (Codex + a beépített cap)

Két dolog együtt: (1) a watchdog 5-próbás capje ágensenként tartósan leállítja a
restartot; (2) Codex plain processként hozta fel őket. Egyik sem VALÓDI fix --
az ágensek stabilak, de süketek+némák Telegramon.

## Helyreállítási terv

Cél (Norbi): az eredetiből minden frissítés nálunk legyen, ÉS a mi munkánk is
működjön. A helyes production-vonal a `develop` (upstream v1.19.0 + minden custom
fix), NEM a `feat/norbull-fleet-v2` (upstream-only).

1. A pull-modell runtime fájljainak visszaállítása lemezre (`4f7ae81`-ből):
   `channel-inbound-tee.mjs` + a valódi 198-soros `channel-inbox-drain.py`.
2. A 4 ágens `settings.json`-jének bedrótozása (a template-változás NEM terjed a
   már futó ágensekhez -- kézzel kell, minden ágensre; ismert buktató).
3. Ezek + a runtime scriptek verziózása develop-ra (PR), hogy egy update ne üsse
   ki újra (a `4f7ae81` mintát követve, de develop-ba mergelve).
4. Az ágensek felhozása `--channels`-szel (teed), egyesével, a cold-boot verseny
   elkerülésével; ellenőrzés hogy a plugin felcsatlakozik ÉS a drain kiüríti a
   már queue-ban ülő üzeneteket.
5. Élő kétirányú teszt mind a 4 ágensnél, mielőtt késznek nyilvánítom.

## Megelőzés / tanulság

- A nem-verziózott ops-fájlokat (hooks, tee, drain) MINDIG mergeld developbe,
  ne csak a live branchen tartsd (`4f7ae81` pont ezt mulasztotta el develop felé).
- Deploy ELŐTT ellenőrizni kell, hogy a checkoutolt branch tartalmazza a custom
  fixeket (merge-base a developpel), különben az upstream-vonal csendben elhagyja
  őket.
- A `channel-monitor` sub-ágens restartja és a pull-modell CSOMAGKÉNT tartoznak
  össze; egyik a másik nélkül crash-loopot ad. Érdemes a monitort úgy védeni,
  hogy hiányzó pull-modell esetén ne induljon végtelen (cap-en belüli) restartba.
