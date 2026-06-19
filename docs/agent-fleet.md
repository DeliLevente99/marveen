# Ügynök-flotta + inter-agent kommunikáció

> Nem egy asszisztens, hanem egy csapat. Specializált ügynökök, akik közvetlenül üzennek egymásnak és együtt visznek végig projekteket.

---

## 🎯 Mit tud / miért érdekes

Marveen egy **orchestrator** (PM-szerep), aki egy specializált ügynök-flottát koordinál — mindegyiknek megvan a maga szerepe (pl. backend-fejlesztés, marketing/frontend, videó, kutatás). Egy nagy feladatnál az orchestrator felbontja a munkát, kiosztja a megfelelő ügynöknek, és összefogja az eredményt.

Az ügynökök **közvetlenül üzennek egymásnak** egy közös üzenetsoron keresztül — nem rajtad keresztül megy minden. Az orchestrator delegál, a szakértő-ügynök dolgozik és visszajelez, te csak a lényeget kapod.

**Kuriózum:** a flotta órákon át önállóan visz végig komplex, több-lépéses projekteket — pl. az egyik ügynök kész a PR-rel, a marketing-ügynök ugyanabból a munkamenetből megírja a bejelentés-szöveget, mindkettő Telegramra értesít. Te a mérföldköveket kapod, nem a belső csevegést.

---

## 🛠 Hogyan működik

### Felépítés

- Minden ügynök egy külön **tmux-session**-ben futó Claude Code példány, saját munkakönyvtárral és `CLAUDE.md`-vel (szerep-specifikus instrukciók).
- Az orchestrator (fő-agent) a dashboardot + a channel-integrációt is futtatja; a sub-agentek a feladataikon dolgoznak.

### Inter-agent üzenetek

Közös SQLite üzenetsor + API:

```
POST /api/messages   { "from": "<agent>", "to": "<agent>", "content": "..." }
GET  /api/messages?agent=<agent>      # státusz
```

A rendszer az üzenetet a célpont ügynök tmux-session-jébe juttatja (`[Uzenet @<felado>-tol]: ...` formátumban), aki feldolgozza és a saját csatornáján válaszol. Csak futó (tmux-session-nel rendelkező) ügynöknek lehet üzenni.

### Életciklus

```
POST /api/agents/<name>/start   # ügynök indítása (tmux + claude --continue)
POST /api/agents/<name>/stop
GET  /api/agents/<name>/status
GET  /api/agents                # flotta-lista
```

Az indítás kezeli a Claude Code "resume summary" modal automatikus elutasítását, hogy a friss session ne ragadjon be.

### Delegálási elv

Egyértelmű szerep-feladatnál az orchestrator magától delegál (nem kérdez minden lépésnél). A feladat kanban-kártyán fut (lásd [kanban](kanban.md)), az `assignee` a felelős ügynök. Az asset-előállító ügynökök (pl. videó) a végeredményt közvetlenül a felhasználó csatornájára küldik.

---

## 📦 Ügynök exportálása / importálása (gépek közötti átvitel)

Egy ügynököt át lehet vinni egyik gépről a másikra egy hordozható `.tar.gz`
bundle-ben, az egész flotta vagy a globális SQLite adatbázis mozgatása nélkül
(az utóbbi a `scripts/backup.sh` dolga). A bundle az `agents/<név>/` mappa
hordozható részhalmaza: identitás + viselkedés, opcionálisan a csatorna-titkokkal.

### Mi kerül a bundle-be

| Tartalom | Mindig | Csak `secrets=1` esetén |
|----------|:------:|:-----------------------:|
| `agent-config.json` (modell, displayName, profil, authMode) | ✅ | |
| `CLAUDE.md`, `SOUL.md` (identitás) | ✅ | |
| `.mcp.json` (MCP eszközök) | ✅ | |
| `avatar.*` | ✅ | |
| `.claude/settings.json`, `.claude/skills/`, `.claude/hooks/` | ✅ | |
| `memory/` (az ügynök saját memóriája) | ✅ | |
| `.claude/channels/*/.env` (channel bot token) | | ✅ |
| `.claude/channels/*/access.json`, `invites.json`, `approved/` (párosítás) | | ✅ |

A gép-specifikus mezők (`remoteHost`, `remoteWorkdir`, `claudeConfigDir`) importkor
**eltávolításra kerülnek**, így az importált ügynök tiszta, helyi ügynökként indul.

### Dashboard

- **Exportálás** (egy ügynök): az ügynök részleteinél az *Exportálás* gomb.
  Rákérdez, hogy a titkokat (channel token, párosítási állapot) belevegyük-e.
  Titkok nélkül a bundle biztonságosan megosztható; titkokkal CSAK saját gépek
  közötti átvitelhez.
- **Összes exportálása** (egész flotta): a Csapat oldal fejlécében az *Összes
  exportálása* gomb -> egyetlen `.tar.gz` az összes al-ügynökkel. Ugyanúgy
  rákérdez a titkokra (ekkor MINDEN ügynöké bekerül).
- **Importálás**: a Csapat oldalon az *Ügynök importálása* gomb -> válaszd ki a
  `.tar.gz` fájlt. Ugyanaz a gomb fogad egy-ügynök ÉS flotta-bundle-t is (a
  backend a manifestből ismeri fel). Névütközéskor felajánlja a felülírást;
  flotta-importnál csak az ütköző ügynökök íródnak felül, a többi azonnal bejön.

### API

```
GET  /api/agents/<név>/export            # egy ügynök bundle-je (titkok nélkül)
GET  /api/agents/<név>/export?secrets=1  # egy ügynök bundle-je titkokkal
GET  /api/agents/export-all              # az EGÉSZ flotta egy bundle-ben (titkok nélkül)
GET  /api/agents/export-all?secrets=1    # az egész flotta titkokkal
POST /api/agents/import                  # bundle feltöltése (multipart: file=, name=, overwrite=1)
                                         #   -- egy-ügynök ÉS flotta-bundle-t is fogad
```

A fő ügynök (`marveen`) egyik módban sem exportálható (a PROJECT_ROOT-ban él,
nem az `agents/` alatt) -- teljes gép-átálláshoz lásd a `scripts/backup.sh`-t és
a [MIGRATION.md](MIGRATION.md)-t.

A flotta-bundle elrendezése `manifest.json` (`kind: "fleet"`) + `agents/<név>/`
ügynökönként; az egy-ügynök bundle `manifest.json` + `agent/`.

### Biztonság

A titkokat tartalmazó bundle channel bot tokeneket hordoz. Ne töltsd fel
megosztott/publikus helyre, és ne tartsd cloud-sync mappában. Emlékeztető:
**egy bot = egy poller** -- ha az importált ügynököt egy második gépen is
elindítod ugyanazzal a tokennel, a Telegram/Slack 409-cel elhasítja a bejövő
üzeneteket. Régi gép le, új gép fel -- soha ne fusson a kettő egyszerre.
