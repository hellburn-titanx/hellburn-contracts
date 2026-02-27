# 🔥 HellBurn Protocol — Security Audit Report

**Auditor:** Claude (AI-assisted manual review)  
**Datum:** 26. Februar 2026  
**Scope:** Alle 6 Core Contracts + Interfaces  
**Methodik:** Manuelle Codeanalyse nach Slither/Mythril Checklisten  

> ⚠️ Dies ist KEIN Ersatz für einen professionellen Audit. Empfehlung: Peer-Review durch DragonX-Founder + Community + automatisierte Tools (Slither, Mythril, Aderyn) lokal ausführen.

---

## Zusammenfassung

| Severity | Anzahl | Status |
|----------|--------|--------|
| 🔴 CRITICAL | 2 | Fixes unten |
| 🟠 HIGH | 5 | Fixes unten |
| 🟡 MEDIUM | 5 | Fixes unten |
| 🔵 LOW | 4 | Empfehlungen |

---

## 🔴 CRITICAL

### C-01: BurnEpochs.finalizeEpoch() — Gesamtes ETH-Balance geht in eine Epoch

**Datei:** `BurnEpochs.sol`, Zeile 134  
**Problem:** `address(this).balance` wird verwendet um ETH einer Epoch zuzuweisen. Wenn sich ETH über mehrere Epochs ansammelt (z.B. Epoch 0 hat 5 ETH, neue 3 ETH kommen rein für Epoch 1), bekommt die erste finalisierte Epoch ALLES — 8 ETH statt 5. Nachfolgende Epochs bekommen 0.

```solidity
// BUGGY:
uint256 ethBalance = address(this).balance;  // ← greift auf GESAMT-Balance zu!
epoch.ethRewards = (ethBalance * REWARDS_PERCENT) / 100;
```

**Impact:** Fund-Drainage. Wer als erstes finalisiert, stiehlt Rewards aller nachfolgenden Epochs.  
**Fix:** ETH pro Epoch tracken, nicht Gesamtbalance verwenden.

---

### C-02: BuyAndBurn.executeBuyAndBurn() — Zero Slippage = Sandwich-Angriff

**Datei:** `BuyAndBurn.sol`, Zeile 75  
**Problem:** `amountOutMinimum: 0` erlaubt MEV-Bots den Swap zu sandwichen. Bei größeren ETH-Beträgen können 30-90% des Wertes gestohlen werden.

```solidity
amountOutMinimum: 0,  // ← Jeder MEV-Bot freut sich
```

**Impact:** Direkter Wertverlust bei jedem Buy-and-Burn.  
**Fix:** Die unprotected Version entweder entfernen oder TWAP-basierten Mindestpreis erzwingen.

---

## 🟠 HIGH

### H-01: GenesisBurn Vesting — Spätere Burns vesten zu schnell

**Datei:** `GenesisBurn.sol`, Zeile 134-136  
**Problem:** `vestingStart` wird nur beim ERSTEN Burn gesetzt. Wer in Woche 1 100 HBURN und in Woche 3 nochmal 100 HBURN mintet, hat den Woche-3-Anteil schon zu ~50% gevestet (weil vestingStart 14 Tage in der Vergangenheit liegt).

```solidity
if (v.vestingStart == 0) {
    v.vestingStart = block.timestamp;  // ← Nur beim ersten Mal!
}
```

**Impact:** User können Vesting umgehen durch strategisches Timing. Mints in Woche 4 sind fast sofort vollständig gevestet.  
**Fix:** Jede Einzahlung separat tracken oder gewichteten Durchschnitt berechnen.

---

### H-02: BurnEpochs._updateStreak() — Underflow bei epochId == 0

**Datei:** `BurnEpochs.sol`, Zeile 297  
**Problem:** `epochId - 1` underflowed in Solidity 0.8+ wenn epochId == 0. Erste Epoch-Teilnahme revertiert wenn ein User vorher schon einen Streak hatte (theoretisch nicht möglich, aber defensive coding fehlt).

```solidity
if (streak.lastParticipatedEpoch == epochId - 1) {  // ← Underflow wenn epochId == 0
```

**Impact:** Edge case, aber könnte die allererste Epoch blockieren.  
**Fix:** Explizite Prüfung `epochId > 0 &&`.

---

### H-03: HellBurnStaking._isStakeOwner() — O(n) Loop = Gas-Griefing

**Datei:** `HellBurnStaking.sol`, Zeile 381-387  
**Problem:** Lineare Suche durch alle Stakes eines Users. Bei 50+ Stakes wird endStake/addFuel extrem teuer.

```solidity
for (uint256 i = 0; i < ids.length; i++) {  // ← O(n), kein Limit
    if (ids[i] == stakeId) return true;
}
```

**Impact:** User mit vielen Stakes zahlen exzessive Gas-Kosten. Potenziell DoS durch Spam-Stakes.  
**Fix:** `mapping(uint256 => address) public stakeOwner` statt Array-Suche.

---

### H-04: HellBurnStaking._addFuel() — Shares ignorieren Loyalty-Bonus

**Datei:** `HellBurnStaking.sol`, Zeile 321  
**Problem:** Bei Fuel-Berechnung wird `amount * timeBonus * fuelBonus` verwendet, aber der LoyaltyBonus fehlt. Original-Berechnung in _startStake war `amount * timeBonus * loyaltyBonus`.

```solidity
// _startStake:  shares = (amount * timeBonus * loyaltyBonus) / (BASIS * BASIS)
// _addFuel:     shares = (amount * timeBonus * s.fuelBonus) / (BASIS * FUEL_BASIS)  // ← loyaltyBonus fehlt!
```

**Impact:** Fuel-Updates zerstören den Loyalty-Bonus. Re-Staker verlieren ihren 1.1x/1.155x Bonus sobald sie Fuel hinzufügen.  
**Fix:** Loyalty-Bonus im Stake speichern und in _addFuel einbeziehen.

---

### H-05: reStake() — Keine Validierung ob User vorher gestaked hat

**Datei:** `HellBurnStaking.sol`, Zeile 134  
**Problem:** Jeder kann `reStake()` statt `startStake()` aufrufen und bekommt sofort den 1.1x Loyalty-Bonus ohne jemals vorher gestaked zu haben.

```solidity
function reStake(uint256 amount, uint256 numDays) external nonReentrant returns (uint256 stakeId) {
    return _startStake(amount, numDays, true);  // ← Keine Prüfung ob User vorherigen Stake hatte
}
```

**Impact:** Gratis 10-15.5% Bonus für alle. Wirtschaftlicher Exploit.  
**Fix:** Prüfen ob User mindestens einen beendeten Stake hat.

---

## 🟡 MEDIUM

### M-01: Penalty-Verteilung — Kommentar sagt 50% an Staker, Code burned 100%

**Datei:** `HellBurnStaking.sol`, Zeile 170-182  
**Problem:** Whitepaper sagt 50% der Penalty geht an Staker, aber der Code sendet beide Hälften an DEAD_ADDRESS.

```solidity
hburn.transfer(DEAD_ADDRESS, burnPortion);     // 50% burn ✓
hburn.transfer(DEAD_ADDRESS, stakerPortion);    // ← Soll an Staker gehen, burned aber!
```

**Impact:** Staker erhalten nie Penalty-Rewards. Nicht kritisch, aber widersprüchlich zum Whitepaper.  
**Fix:** Entscheidung treffen: Entweder alles burnen (deflationärer) oder tatsächlich an Staker verteilen.

---

### M-02: Kein Emergency-Pause Mechanismus

**Problem:** Keiner der Contracts hat eine Pause-Funktion. Bei einem Exploit gibt es keinen Kill-Switch.  
**Fix:** OpenZeppelin Pausable mit Timelock. Pause nur für Deposits, nicht für Withdrawals.

---

### M-03: Kein max-Supply Cap auf HBURN

**Datei:** `HellBurnToken.sol`  
**Problem:** Während Genesis kann theoretisch unbegrenzt geminted werden (limitiert nur durch verfügbares TitanX).  
**Impact:** Gering da Genesis zeitlich begrenzt ist, aber ein expliziter Cap wäre sicherer.  
**Fix:** `MAX_SUPPLY` Konstante mit Prüfung in mint().

---

### M-04: DragonX transferFrom — Kein Return-Value Check

**Datei:** `BurnEpochs.sol`, Zeile 264-269 und `HellBurnStaking.sol`, Zeile 300-305  
**Problem:** Low-level call für DragonX prüft nur `success` Bool, nicht den Return-Value. Manche ERC-20 Tokens returnen nichts (non-standard), andere returnen `false` ohne zu reverten.

**Fix:** SafeERC20 von OpenZeppelin verwenden.

---

### M-05: BurnEpochs — Verwaiste ETH wenn keiner in einer Epoch burned

**Problem:** Wenn eine Epoch keine Teilnehmer hat (`totalWeightedBurns == 0`), wird das ETH nicht verteilt und sitzt fest im Contract.  
**Fix:** Unverteiltes ETH an nächste Epoch weiterleiten.

---

## 🔵 LOW

### L-01: Fehlende Zero-Address Checks in Constructors
Alle Constructors akzeptieren `address(0)` ohne Prüfung.

### L-02: getTier() gibt String zurück
Gas-verschwendend für On-Chain Nutzung. Besser: uint8 Enum.

### L-03: Keine Events für consecutiveRestakes / Phoenix in Staking
Schwieriger für Off-Chain Tracking.

### L-04: GenesisBurn.endGenesis() — Misleading Error
Wirft `GenesisNotStarted` wenn man zu früh aufruft, aber die Semantik ist "Genesis not ended yet".

---

## Empfehlungen für Produktionsreife

1. **ALLE Critical + High Findings fixen** (siehe Fixes unten)
2. **Slither + Mythril + Aderyn lokal laufen lassen** (Befehle am Ende)
3. **Fuzz-Testing mit Foundry** für Epoch-Finalisierung und Staking
4. **Deployment Caps:** Max TVL beim Launch begrenzen (z.B. 50 ETH)
5. **Timelock für alle Admin-Funktionen** (falls welche hinzukommen)
6. **Testnet-Deployment** auf Sepolia für mindestens 2 Wochen
7. **Peer-Review** durch DragonX-Founder + Community
8. **Immunefi Bug Bounty** vor Mainnet-Launch registrieren

---

## Tool-Befehle für lokale Analyse

```bash
# Slither (Trail of Bits)
pip install slither-analyzer
cd hellburn
slither . --config-file slither.config.json 2>&1 | tee slither-report.txt

# Mythril (ConsenSys)
pip install mythril
myth analyze contracts/BurnEpochs.sol --solc-json mythril.config.json

# Aderyn (Cyfrin)
curl -L https://raw.githubusercontent.com/Cyfrin/aderyn/dev/cifrin-install | bash
aderyn . --output aderyn-report.md

# Foundry Fuzz Testing
curl -L https://foundry.paradigm.xyz | bash
foundryup
forge test --fuzz-runs 10000
```

---

*Report generiert am 26.02.2026. Nächster Schritt: Fixes implementieren.*
