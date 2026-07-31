# Visual Deliverable QC-Gate Contract

**Verzió:** 1.5  
**Dátum:** 2026-07-18  
**Szerző:** nova (kockázatelemzés) + orin (koordináció)  
**Hivatkozások:** `docs/client-deliverable-governance.md`, `store/governance-inputs/model-routing.json`, `src/costops/circuit-breaker.ts`

---

## Összefoglaló

Ez a dokumentum definiálja a Moonwright Studio vizuális és videó deliverable-ok 5-kapus minoszegy-kapuját (QC-Gate Contract). Minden kliensnek leszállított kép, grafika, videó vagy social asset ezen a csatornán halad át, mielőtt lezárható. A kapuk sorrendben futnak; bármelyik FAIL blokkolja a következőt.

Az összes P0 hiba (Iris QC fail_code) azonnali blokkolót jelent - a pontozó rubrika csak nulla P0 esetén kerül kiértékelésre.

---

## A 11 P0 fail_code (Azonnali blokk)

Ezek az Iris QC-rubrika v1.0 canonical fail_code-jai, a `src/costops/circuit-breaker.ts` `FAIL_CODES` konstansából:

| Kód | Leírás |
|-----|--------|
| `BRAND_LOCK_MISSING` | A brand.lock.json hiányzik vagy nem `validated` státuszban van |
| `RATIO_MISMATCH` | A deliverable aránya nem felel meg a platform követelményének |
| `TEXT_OUTSIDE_SAFE_ZONE` | Szöveg a safe zone-on kívül (lehet levágva a platformon) |
| `COLOR_MISMATCH` | Mért szín > deltaE tolerancia a brand.lock.json `qc.colors` értékeitől |
| `FONT_MISMATCH` | Nem engedélyezett tipográfiai família vagy súly |
| `LOGO_MISSING` | A kötelező logo variáns hiányzik |
| `LOGO_MISPLACED` | Logo elhelyezés sérti a `placement_rules` min clear space szabályát |
| `AI_ARTIFACT_DETECTED` | Látható generálási artefakt (ghost limb, pixel-smear, warped text) |
| `PROHIBITED_ELEMENT` | A brand.lock.json `qc.prohibited_elements` listáján szereplő elem |
| `LOW_RESOLUTION` | Felbontás a platform minimum alatt (ld. Gate 2) |
| `UNSUPPORTED_FORMAT` | Fájlformátum nem megfelelő a leszállítási csatornának |
| `HAND_ANATOMY_DEFECT` | Emberi kézen látható AI-generálási defekt: összeolvadt/hiányzó/extra ujj, warp, ujjszám != 5 ahol számlálható, tiszta szeparáció hiánya - KIEMELTEN mozgó/gesztikuláló és terméket-tartó kezeken. **HÁROM KÖTELEZŐ KAPU (compose-then-animate pipeline-ban):** (1) hero-still automata ujjszámlálás - animáció ELŐTT, olcsó, döntő (Dex/Nova); (2) human hero-approval - Orin saját explicit verdiktje (indoklással) + Norbi ellenőrzi kép+verdikt + Norbi GO, animáció ELŐTT, kalibrációs tanuló-hurok; (3) anim frame-by-frame - Gate 4-ban, mintavétel TILTOTT (Nova). (1) kihagyása ~$0.60 pazarlás; (2) kihagyása szubjektív minőségi kockázat. (Tanulság: 2026-07-18 LUME demo - flux_edit 6-ujjas hero-stillt generált; (1)+(2) kapuk hiánya okozta a Gate 4 P0 misst.) |

**P0 szabály:** egyetlen P0 jelenlétében a deliverable FAIL, a pontszám irreleváns. A P0-t a retry ciklusban mindig meg kell szüntetni.

---

## Az 5 kapu

### Gate 1 - Brand & Toolchain Readiness

**Cél:** mielőtt bármilyen generálás történik, ellenőrzi, hogy az összes szükséges input és eszköz elérhető.

**Ellenőrzési pontok:**

- [ ] `04_Brand/brand.lock.json` létezik és `status` == `validated`
- [ ] Minden `master_refs[]` fájl jelen van és sha256 egyezik (nincs drift)
- [ ] A model-routing.json-ban kijelölt generáló modell/endpoint elérhető (fal.ai liveness)
- [ ] Referencia csomag összeállítva: master sheet, LoRA checkpoint (ha recurring_character_or_product), platform spec
- [ ] Brief tartalmaz: leszállítandó platformok, aspect ratio-k, szöveges elemek listája

**Eredmény:**
- PASS: minden checkbox teljesül -> Gate 2
- FAIL: `BRAND_LOCK_MISSING` P0 emelve, pipeline megáll, Orin értesítve

**Aktor:** Orin (task routing) + Dex (toolchain check)

---

### Gate 2 - Format & Resolution Completeness

**Cél:** a generált fájlok technikai specifikációjának megfelelőség-ellenőrzése, minden platformra.

**Platform minimumok (referencia):**

| Platform | Minimális felbontás | Elfogadott formátum | Arány |
|----------|--------------------|--------------------|-------|
| Instagram post | 1080x1080 px | JPG, PNG | 1:1 |
| Instagram Story / Reels | 1080x1920 px | JPG, PNG, MP4 | 9:16 |
| Facebook post | 1200x630 px | JPG, PNG | 1.91:1 |
| YouTube thumbnail | 1280x720 px | JPG, PNG | 16:9 |
| HD video | 1920x1080 px | MP4 (H.264), MOV | 16:9 |

**Ellenőrzési pontok:**

- [ ] Minden briefben szereplő platformhoz van kész fájl
- [ ] Felbontás >= platform minimum (ha nem: `LOW_RESOLUTION` P0)
- [ ] Fájlformátum elfogadott az adott csatornán (ha nem: `UNSUPPORTED_FORMAT` P0)
- [ ] Aspect ratio megfelel a brief specifikációjának (ha nem: `RATIO_MISMATCH` P0)
- [ ] Fájlméret ésszerű (kép: <= 20 MB, videó: <= 500 MB)

**Eredmény:**
- PASS: minden formátum kész, P0 nincs -> Gate 3
- FAIL: azonosított P0 kódok + retry trigger

**Aktor:** Dex (fájlkezelés, export)

---

### Gate 3 - Automated P0 Screen

**Cél:** automatizálható P0 hibák szisztematikus felderítése generálás után, manuális Gate 4 előtt. Csökkenti a manuális review terhelését.

**Automatizálható ellenőrzések:**

- [ ] **OCR szöveg-ellenőrzés** -- minden generált szöveg kiolvasása, összehasonlítás a source text-tel, különös figyelemmel a magyar ékezetekre (á é í ó ö ő ú ü ű; a model-routing.json `text_validation` pipeline alapján)
- [ ] **Text safe zone check** -- szöveg bounding box a platform safe zone határain belül van-e
- [ ] **Color delta-E mérés** -- domináns színek kivonása, összehasonlítás a brand.lock.json `qc.colors` értékeivel, deltaE tolerancia alapján
- [ ] **Logo jelenlét detekció** -- logo régió azonosítható-e a deliverable-ben
- [ ] **Artifact screen** -- könnyen detektálható generálási artefaktek (pixel-smear, ismétlődő minták a széleken)

**Megjegyzés:** az automatizálás mértéke a pipeline érettségétől függ. Az ellenőrzések ma részben manuálisak, a Gate 3 fokozatosan automatizálható. A cél: csak azokat a P0 kódokat dobja Gate 4-re, amik nem detektálhatók automatikusan.

**Eredmény:**
- PASS (0 P0 detektálva) -> Gate 4
- FAIL: P0 lista -> retry vagy Orin dönt (circuit-breaker logika alapján)

**Aktor:** Dex (script/API), Nova (manuális ahol szükséges)

---

### Gate 4 - Manual Content Review (BLOKKOLÓ)

**Ez a pipeline egyetlen blokkoló kapuja.** A Gate 4 kizárólag akkor PASS, ha:
1. Nulla P0 fail_code van
2. A pontozó rubrika összpontszáma >= 90 / 100

**Nova végzi el.** Ideje: kép esetén 5-10 perc, videó esetén 15-30 perc.

**Ellenőrzési területek:**

- **Arc-identitás** (recurring_character/product esetén): az arc/termék azonos a master sheet-tel, LoRA-konzisztens; nincs morfológiai drift
- **Termékforma és részletek**: logó, varrat, szín, anyagminőség, termékfeliratok egyeznek a master view-val
- **Logo elhelyezés és méret**: clear space szabály, variáns megfelelő a kontextushoz (primary/mono)
- **Színek**: szubjektív vizuális egyezés a branddel, deltaE-n túl a "feel" is számít
- **Anatómia és fizika (P0-szintű kéz-check kötelező)**: emberalak esetén MINDEN látható emberi kéz vizsgálata kötelező: ujjszám=5 ahol számlálható, tiszta ujj-szeparáció, nincs összeolvadás/warp/extra vagy hiányzó ujj, természetes ízületek - KIEMELTEN mozgó/gesztikuláló kezeken és terméket-tartó kezeken; végtagok, perspektíva; objektum esetén gravitáció, anyagtulajdonságok.

  **VIDEÓNÁL HÁROM KÖTELEZŐ KÉZELLENŐRZÉSI KAPU (sorrendben, animáció előtt és után):**

  **(1) Hero-still rigorous ujjszámlálás -- ELSŐ, OLCSÓ, DÖNTŐ** (animáció ELŐTT, Gate 3-ban vagy közvetlenül utána): ugyanolyan szigorral mint az OCR-cimke-check. Ujjszám=5 minden számlálható kézen, nincs összeolvadt/extra/elnyúlt ujj, tiszta szeparáció. Ha FAIL -> új hero generálás (~$0.10), animáció NEM indul. Hibás heróra animációt indítani ~$0.60 felesleges pazarlás. A generátor (flux_edit, gpt-image) maga is produkálhat 6-ujjas hero-stillt -- ez a kapu fogja el, nem az anim-check. Aktor: Dex/Nova.

  **(2) Human hero-approval -- KÖTELEZŐ HUMAN-IN-THE-LOOP kalibrációs hurokkal** (animáció ELŐTT, (1) PASS után): Orin a hero-stillt SAJÁT EXPLICIT VERDIKTJÉVEL együtt küldi Norbinak - nem csak továbbítja, hanem konkrét indoklással nyilatkozik ("átengedném / nem, mert...": ujjszám, cimke-helyesség, termék-pontosság, kompozíció). Norbi MINDKETTŐT ellenőrzi: a képet ÉS Orin ítéletét. Animáció kizárólag Norbi explicit GO-jára indul. Cél: kalibrációs tanuló-hurok - Norbi látja Orin döntőképességét, Orin tanulja Norbi sztenderdját a korrekciókból; idővel Orin ítélete megbízhatóbbá válik, Norbi lazíthat a kézi ellenőrzésen. A végső GO mindig Norbié. Aktor: Orin (saját verdikt + koordináció) -> Norbi (ellenőrzés + GO).

  **(3) Anim frame-by-frame check -- harmadlagos** (Gate 4-ban, animáció UTÁN): mintavételes (start/mid/end) check TILTOTT. Talking-avatar/gesztikuláló klipeknél az animáció kockáról-kockára változik; egyetlen defektes kocka is P0 diszkvalifikáció. Minimális keret-szám: ~5-8 egyenletesen elosztott kocka + MINDEN kocka ahol a kéz fókuszban van és ujjak számlálhatók. Szükséges még ha (1)+(2) PASS volt, mert az animáció tiszta hero-stilltől is generálhat új defektet. Aktor: Nova.

  (Tanulság: 2026-07-18 LUME demo c3c - a flux_edit 6-ujjas hero-stillt generált, az anim hűen vitte tovább; (1) és (2) kapuk hiánya okozta a P0 misst Gate 4-nél.)
- **Szöveg és ékezetek**: OCR-en felül vizuálisan is olvasható, kerning/spacing elfogadható
- **Frame-to-frame drift** (video): azonos jelenet felvételei között nincs identitás- vagy szín-ugrás, cut-on-action konzisztens
- **Tiltott elemek**: brand.lock `prohibited_elements` lista alapján vizuális check

#### A pontozó rubrika (100 pont)

| Dimenzió | Max pont | Leírás |
|----------|----------|--------|
| Brand-konzisztencia | 30 | Logo (jelenlét, elhelyezés, variáns), szín (deltaE + szubjektív feel), tipográfia (família, súly, méret), brand elements jelenléte |
| Technikai minőség | 25 | Felbontás (platform felett van-e tartalékkal), élesség, artefakt-mentesség, fájl integritás, formátum |
| Identitás-hűség | 20 | Arc/termék konzisztencia a master sheet-tel; videónál frame-to-frame stabilitás; LoRA koherencia |
| Szöveg-pontosság | 15 | OCR egyezés a source text-tel, ékezetek (vizuális ellenőrzés), safe zone elhelyezés, olvashatóság |
| Kompozíció & Brief-megfelelés | 10 | Vizuális egyensúly, platform-kompatibilitás (safe zone kihasználtsága), a brief szándékával való összhang |

**Pontozási irányelvek:**

- **30/30 (Brand):** minden brand elem tökéletesen egyezik, szín deltaE < 2
- **24-29 (Brand):** apró eltérés (deltaE 2-4), elfogadható ha P0 nincs
- **< 20 (Brand):** COLOR_MISMATCH vagy FONT_MISMATCH P0 szint -- Gate 4 nem juthat el idáig

- **25/25 (Technikai):** éles, artefakt-mentes, 2x platform min felett
- **20-24 (Technikai):** platform min felett de szoros, vagy minimális artefakt ami nem P0 szintű
- **< 15 (Technikai):** LOW_RESOLUTION vagy AI_ARTIFACT P0 -- Gate 3 fogja el

- **20/20 (Identitás):** az alany azonnal felismerhető, nincs drift
- **15-19 (Identitás):** kisebb drift (pl. megvilágítás eltér), de az identitás megmarad
- **< 10 (Identitás):** az alany nem azonosítható a master sheet alapján -- blokk

- **15/15 (Szöveg):** OCR 100%, ékezetek mind helyes, vizuálisan is olvasha
- **10-14 (Szöveg):** 1-2 apró hiba ami nem zavarja az olvasást; ékezet-warning
- **< 8 (Szöveg):** TEXT_OUTSIDE_SAFE_ZONE vagy hibás ékezet P0 szinten -- Gate 3 fogja el

- **10/10 (Kompozíció):** a brief szándékával tökéletesen összhangban, platformra optimalizált
- **7-9 (Kompozíció):** elfogadható, kisebb javítási lehetőség
- **< 5 (Kompozíció):** a brief szándékával nem egyezik -- blokk, de ne legyen P0 (ez szubjektív dimenzió)

**Küszöb és döntés:**

| Eredmény | Feltétel | Következő lépés |
|----------|----------|-----------------|
| PASS | P0 = 0 ÉS pontszám >= 90 | Gate 5 |
| CONDITIONAL | P0 = 0 ÉS pontszám 80-89 | Nova ajánlás Orin-nek: elfogad vagy retry |
| FAIL | Bármely P0 VAGY pontszám < 80 | Retry (circuit-breaker logika) |

**Aktor:** Nova

---

### Gate 5 - Archive & Handoff Integrity

**Cél:** a jóváhagyott deliverable archívumba kerül, a státuszok frissülnek, a lánc lezárható.

**Ellenőrzési pontok:**

- [ ] Fájl(ok) a `clients/<ClientName>/99_Deliverables/` mappában, konzisztens névkonvencióval
- [ ] Kanban kártya státusza `done`, Gate 4 pontozása kommentben rögzítve
- [ ] Ha a brand.lock frissült: `validated_by` + `validated_at` mezők beírva
- [ ] Generálási metadata naplózva (modell, cost, retry szám) a token_usage + deliverable_attempts táblában
- [ ] Kliens felé szállított verziók verziójelölve és archiválva

**Eredmény:**
- PASS: minden checkbox teljesül -> deliverable lezárva
- FAIL: adminisztratív hiba, nem generálási probléma -> Dex javítja

**Aktor:** Dex (archiválás, logging), Orin (kanban lezárás)

---

## Retry logika

A circuit-breaker (`src/costops/circuit-breaker.ts`) kezeli a retry kapuzást. A contract szempontjából:

```
Kezdeti generálás -> Gate 1-5
  Ha FAIL (Gate 3 vagy 4):
    attempt_number <= max_retries (default: 2)?
      -> RETRY: prompt/referencia módosítás kötelező (azonos input tiltott)
    attempt_number > max_retries:
      -> hold_awaiting_approval: kanban BLOKK label + Orin értesítés
    2x azonos fail_code (systematic_fail_threshold: 2)?
      -> orin_decision: modell/megközelítés váltás Orin dönt
    budget_cap elérve?
      -> hard_hold: generálás tiltott az adott napon/projekten
```

**Max próbálkozások:** 3 (initial + 2 retry)  
**Retry szabály:** a prompt, referencia csomag, vagy modell választás KELL hogy változzon a retry-ban  
**Systematic escalation:** 2x azonos fail_code -> Orin dönt, nem auto-switch

---

## Szerepek összefoglalása

| Szerep | Felelősség a pipeline-ban |
|--------|--------------------------|
| Orin | Task routing, Gate 1 trigger, escalation fogadás, kanban koordináció |
| Iris | Brief összeállítás, referencia csomag, brand.lock karbantartás |
| Dex | Modell hívás, fájlkezelés, Gate 2 format check, Gate 5 archiválás |
| Nova | Gate 3 manuális P0 screen, Gate 4 manual review, pontozás, blokk döntés |
| Atlas | Pipeline metrikák: retry ráta, elfogadási arány, modell teljesítmény |

---

## Hivatkozások

- Iris QC fail_codes canonical helye: `src/costops/circuit-breaker.ts` `FAIL_CODES`
- Circuit-breaker logika: `src/costops/circuit-breaker.ts`
- Circuit-breaker konfig (retry cap, budget): `src/costops/config.ts` + `DEFAULT_CIRCUIT_BREAKER`
- Model routing: `store/governance-inputs/model-routing.json`
- brand.lock schema: `docs/client-deliverable-governance.md`
- Client taxonomy (00-99 zónák): `docs/client-deliverable-governance.md`
