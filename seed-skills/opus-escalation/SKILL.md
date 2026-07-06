---
name: opus-escalation
description: orin (koordinator, alap Sonnet) atmeneti Opus-ra valtasa EGY konkret, nagyon komplex koordinacios helyzetre (nehez tobblepeses orchestration, kritikus permission/deploy dontes), majd visszavaltas. Trigger -- amikor a jelenlegi feladat tulmutat a rutinon es Opus-szintu iteles kell. Norbi kikotese: CSAK ha tenyleg kell, SOHA nem rutinszeruen.
---
# Opus-escalation fallback (orin)

## Mikor hasznald
Alapbol Sonnet-en futsz (olcso koordinacio). Ritkan egy konkret helyzet Opus-szintu itelest
kivan: nehez tobblepeses orchestration, osszetett merge/konfliktus-strategia, kritikus
permission-router vagy deploy dontes, ahol a hiba draga. Ilyenkor -- es CSAK ilyenkor --
kerhetsz atmeneti Opus-eszkalaciot. NE hasznald rutin feladatra, egyszeru valaszra,
statuszra. Norbi kikotese: nagyon szukseges esetben, nem megszokasbol.

A valtas ELO `/model` injektalassal tortenik: a beszelgetes-kontextusod MEGMARAD (nincs
restart). A prompt-cache egyszer ujraepul (a valtas utani elso uzenet dragabb), ezert is
ritka, celzott hasznalat a helyes.

## Eljaras
1. Eszkalacio kerese (opcionalis `reason` audithoz):
   ```bash
   curl -s -X POST http://localhost:3420/api/agents/escalate \
     -H "Authorization: Bearer $(cat /home/karma/marveen/store/.dashboard-token)" \
     -H 'Content-Type: application/json' \
     -d '{"reason":"MIERT kell Opus (rovid)"}'
   ```
   A valasz `enabled:false`-t ad, ha a feature meg ki van kapcsolva -- ekkor a keres rogzul,
   de valtas NEM tortenik, amig operator be nem kapcsolja.
2. A runner a kovetkezo idle tickeden (~60s, csak amikor a paneled nem dolgozik) atvalt Opus-ra.
   Ellenorzes: `GET /api/agents/escalation` -> `state.appliedModel` == `claude-opus-4-8[1m]`.
3. Amikor a nehez resz kesz, VALTS VISSZA azonnal (ne hagyd Opuson feleslegesen):
   ```bash
   curl -s -X POST http://localhost:3420/api/agents/de-escalate \
     -H "Authorization: Bearer $(cat /home/karma/marveen/store/.dashboard-token)"
   ```

## Buktatok
- **Biztonsagi cap**: a rendszer `maxEscalationMinutes` (alap 30 perc) utan MINDENKEPP
  visszavalt Sonnet-re, akkor is ha elfelejtel de-escalate-elni -- soha nem ragadsz Opuson.
  De ne erre tamaszkodj: fejezd be es valts vissza kezzel.
- **Feature-kapcsolo**: default DISABLED (`store/opus-escalation.json` `enabled:false`). Amig egy
  operator be nem kapcsolja (dashboard/config), a keres csak rogzul. Ha `enabled:false`-t kapsz
  es tenyleg kell az Opus, szolj Norbinak/operatornak.
- **Idle-gate**: a valtas csak akkor fut le, ha a paned eppen nem dolgozik (nem szakit meg
  elo turn-t). Ezert a valtas nehany masodperc kesessel all be, nem azonnal.
- **Nem rutin**: ha azon kapod magad hogy gyakran eszkalalsz, az jelzes hogy vagy a
  koordinator-alapmodell keves, vagy tulhasznalod. Norbi figyeli a koltseget.

## Ellenorzes
- `GET /api/agents/escalation` -> `config.enabled`, `state.active`, `state.appliedModel`.
- A pane also soraban a `/model` utan "Set model to ..." jelzi a sikeres valtast.
- Visszavaltas utan `state.active:false` es `state.appliedModel` == base (`claude-sonnet-4-6`).
