# 🔥 HellBurn — Setup & Security-Analyse Guide

## 1. Projekt aufsetzen

```bash
# In den Projektordner wechseln
cd hellburn

# Dependencies installieren
npm install

# Kompilieren (erster Test ob alles passt)
npx hardhat compile
```

Wenn `compile` ohne Fehler durchläuft → Contracts sind syntaktisch korrekt.

---

## 2. Slither installieren & ausführen

Slither ist der Industriestandard von Trail of Bits. Es findet automatisch ~90 bekannte Schwachstellen-Patterns.

### Installation

```bash
# Python 3.8+ muss installiert sein
python3 --version

# Slither installieren
pip3 install slither-analyzer

# Prüfen ob es funktioniert
slither --version
```

> **Windows?** Am einfachsten via WSL (Windows Subsystem for Linux).  
> **Mac?** `brew install python3 && pip3 install slither-analyzer`

### Ausführen

```bash
# Im hellburn/ Projektordner:
slither . --config-file slither.config.json

# Für detaillierten Report als Markdown:
slither . --config-file slither.config.json --checklist > slither-report.md

# Nur High + Medium Severity:
slither . --config-file slither.config.json --exclude-low
```

### Was du siehst

Slither gibt Findings in Kategorien aus:
- 🔴 **High** — Sofort fixen (Reentrancy, unbegrenzter Zugriff, etc.)
- 🟡 **Medium** — Solltest du dir anschauen
- 🔵 **Low / Informational** — Nice-to-have, oft False Positives

**Typische False Positives bei unserem Code:**
- `reentrancy-benign` auf nonReentrant-Funktionen → ist OK, wir haben den Guard
- `low-level-calls` für ETH-Transfers → ist gewollt (`.call{value:}`)
- `timestamp` Abhängigkeit → ist bei Epochs unvermeidbar

### Konkretes Beispiel

```
$ slither .

BurnEpochs._burn(address,uint256,uint256) (contracts/BurnEpochs.sol#241-270)
   uses timestamp for comparisons
        - block.timestamp < firstEpochStart (contracts/BurnEpochs.sol#245)
   
   Reference: https://github.com/crytic/slither/wiki/Detector-Documentation#timestamp

   → FALSE POSITIVE: Wir brauchen Timestamps für Epoch-Timing.
     Miner können max ~15 Sekunden manipulieren, irrelevant für 8-Tage-Epochs.
```

---

## 3. Mythril installieren & ausführen

Mythril macht symbolische Ausführung — es simuliert alle möglichen Codepfade und sucht nach Zuständen die nicht eintreten sollten.

### Installation

```bash
# Option A: via pip
pip3 install mythril

# Option B: via Docker (empfohlen — weniger Installationsprobleme)
docker pull mythx/myth
```

### Ausführen

```bash
# Einzelner Contract (pip-Installation):
myth analyze contracts/BurnEpochs.sol --solc-json mythril.config.json --max-depth 12

# Alle Contracts nacheinander:
for f in contracts/*.sol; do
  echo "=== Analyzing $f ==="
  myth analyze "$f" --solc-json mythril.config.json --max-depth 12 --execution-timeout 300
done

# Via Docker:
docker run -v $(pwd):/code mythx/myth analyze /code/contracts/BurnEpochs.sol
```

> ⚠️ Mythril ist LANGSAM. Ein Contract kann 5-30 Minuten dauern. Das ist normal.

### Was du siehst

```
==== Integer Arithmetic Bugs ====
SWC ID: 101
Severity: High
...
```

Mythril gibt SWC-IDs aus (Smart Contract Weakness Classification). Die wichtigsten:
- **SWC-101**: Integer Over/Underflow → bei Solidity 0.8+ False Positive (built-in checks)
- **SWC-107**: Reentrancy → prüfen ob nonReentrant vorhanden
- **SWC-110**: Assert violation → echtes Problem
- **SWC-116**: Timestamp dependency → wie bei Slither, meist harmlos für uns

---

## 4. Aderyn (Bonus — sehr schnell)

Neues Tool von Cyfrin (Patrick Collins' Team). Geht in Sekunden statt Minuten.

```bash
# Installation
curl -L https://raw.githubusercontent.com/Cyfrin/aderyn/dev/cyfrin-install | bash
source ~/.bashrc

# Ausführen
aderyn .

# Report als Markdown
aderyn . --output aderyn-report.md
```

---

## 5. Hardhat Tests ausführen

```bash
# Alle Tests
npx hardhat test

# Mit Gas-Report
REPORT_GAS=true npx hardhat test

# Einzelner Test
npx hardhat test --grep "BurnEpochs"
```

---

## 6. Deploy (Testnet zuerst!)

```bash
# .env anlegen
cp .env.example .env
# → .env editieren mit deinen Keys

# Auf Sepolia deployen
npx hardhat run scripts/deploy.js --network sepolia

# Contracts auf Etherscan verifizieren
npx hardhat verify --network sepolia <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS...>
```

---

## 7. Checkliste vor Mainnet

```
[ ] Slither: 0 High findings (oder alle erklärt)
[ ] Mythril: 0 High findings (oder alle erklärt)
[ ] Aderyn: Review gelesen
[ ] Hardhat Tests: alle grün
[ ] Sepolia: 2+ Wochen getestet
[ ] Peer-Review: DragonX-Founder hat drübergeschaut
[ ] Guardian: Multisig (Gnosis Safe) erstellt
[ ] Immunefi: Bug Bounty registriert
[ ] LP: Uniswap V3 Pool vorbereitet
```

---

## Troubleshooting

**`slither: command not found`**
→ Python Scripts-Ordner nicht im PATH. Fix: `export PATH="$HOME/.local/bin:$PATH"`

**`myth: SolcNotInstalled`**
→ Mythril braucht solc. Fix: `pip3 install py-solc-x && python3 -c "from solcx import install_solc; install_solc('0.8.24')"`

**`npx hardhat compile` → `Error: Cannot find module '@openzeppelin/contracts'`**
→ `npm install` nicht gelaufen. Fix: `npm install`

**Slither zeigt hunderte Warnings in node_modules**
→ Die `slither.config.json` filtert das schon. Falls nicht: `slither . --filter-paths "node_modules"`
