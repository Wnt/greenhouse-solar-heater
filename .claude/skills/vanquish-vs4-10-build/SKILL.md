---
name: vanquish-vs4-10-build
description: >-
  Guide the purchase of a Vanquish VS4-10 Origin Classic Pro Kit (VPS09026B) and
  every extra component needed to make it a fully working 1/10 RC rock crawler —
  motor, ESC, steering servo, battery, charger, tires, and radio. EU-sourcing
  focused, rc-multistore.com first. Use when the user wants to spec, price, or
  buy this truck (or asks which motor/ESC/servo/battery/tires/radio to pair with
  a VS4-10).
metadata:
  author: research-synthesis
  scope: EU resellers (rc-multistore.com primary)
  researched: 2026-06
---

# Buying a Vanquish VS4-10 Origin Classic Pro — complete build guide (EU)

This skill turns a bare **VS4-10 Origin Classic Pro Kit** into a shopping list for a
fully working RC crawler. Prices are EUR, gathered ~June 2026, **rc-multistore.com
(Germany, ships EU-wide, EUR, VAT incl.) first**, with named EU fallbacks where
rc-multistore doesn't stock an item. **Always re-verify price + stock on the
product page before ordering — prices and availability drift.**

## How to use this skill

1. Confirm the user's intent: budget tier, and whether they want a one-stop-shop
   (everything from rc-multistore) or best-of-breed (accept a few extra shops).
2. Walk them through the 6 required component categories below. Each missing part
   is genuinely required — the kit cannot run without it.
3. Offer one of the three **sample builds** as a starting point, then swap
   individual parts per the tiered tables.
4. Run the **compatibility checklist** before they pay — it's where crawler builds
   go wrong (connector mismatch, brushed-vs-brushless ESC, BEC current, wheel size).

> **Communication note:** lead with full names ("steering servo", "speed
> controller / ESC", "2S LiPo battery"), not jargon, unless the user is clearly an
> experienced builder.

---

## 0. The kit itself — what you're starting from

**Vanquish VS4-10 Origin Classic Pro Kit, Black Axles — SKU VPS09026B**
- rc-multistore price: **€854.99** (≈5% off €899.99).
- ⚠️ **Stock:** was **NOT in stock** at rc-multistore at research time ("aktuell NICHT
  verfügbar") — contact the store to confirm orderability/backorder, or use an EU
  fallback (AMain ships from US with import; check EuroRC/other EU Vanquish dealers).
- Product page: https://www.rc-multistore.com/Vanquish-VS4-10-Origin-Classic-Pro-Kit-Black-Axles-VPS09026B
- Official spec (authoritative): https://vanquishproducts.com/products/vs4-10-origin-classic-pro

**Key specs that drive every component choice:**

| Spec | Value | Implication |
|---|---|---|
| Scale / drive | 1/10, 4WD | 540-class electronics |
| Wheelbase | 313 mm (12.3") | — |
| Transmission | **Single-speed VFD, 6.5% overdrive** | ⚠️ **NOT a 2-speed** — no shift servo/channel needed |
| Motor mount | **Standard 540** (brushed or brushless) | any 540-can motor fits |
| Battery | **2S–3S LiPo** (kit page doesn't state; inferred from Vanquish's matching electronics) | pick ESC that matches your cell count |
| Wheels | **INCLUDED** — 1.9" Battle Born "X-Ray" wheels + 475 SLW hubs | **only tires needed, not wheels** |
| Body | **INCLUDED** — Origin Classic body, **unpainted/clear** | budget paint + Lexan prep |
| Servo spline | **25T** (25T horn included) | any 25T crawler servo fits |

**What the kit does NOT include — your shopping list:**
1. **Tires** (+ foams + glue) — wheels ARE included
2. **Motor** (540)
3. **ESC** (speed controller)
4. **Steering servo**
5. **Battery** (2S/3S LiPo)
6. **Charger**
7. **Transmitter + receiver** (radio)
8. Paint for the body; basic build tools (hex drivers)

> There is **no RTR of the Origin Classic**. If the user balks at building/specing,
> mention the platform siblings that ship fully built (only add a LiPo): VS4-10
> **Phoenix Portal RTR** (~€440.99 at rc-multistore) or **H10 Optic RTR** (~€464.99).

---

## 1. Motor + ESC (speed controller)

A heavy 1/10 trail crawler wants smooth low-speed torque. KV sweet spot ≈
**1800 KV on 3S** or **2300 KV on 2S** (brushless), or **~30–35T** (brushed).
**The integrated 2-in-1 combos remove all brushed/brushless mismatch risk** and are
what most VS4-10 owners run today.

| Tier | Pick | Type | EUR | Source |
|---|---|---|---|---|
| **Budget** | Hobbywing QuicRun **WP1080 Combo, 540 30T** | Brushed, 2–3S, waterproof | **€68.90** | [rc-multistore](https://www.rc-multistore.com/Hobbywing-Quicrun-Brushed-WP1080-Combo-540-30-Turn-HW38020349) |
| **Recommended** ★ | Hobbywing **QuicRun Fusion 1800kV** (2-in-1 FOC) | Brushless+ESC integrated, IP67, 6A BEC | ~€100–115 | [rc-multistore Hobbywing cat.](https://www.rc-multistore.com/Hobbywing-Germany-Online-Shop) |
| **Recommended+** | Hobbywing **QuicRun Fusion Pro 2300kV** | Integrated, 60A, IP67, 6A BEC | **€118.79** | [rc-multistore](https://rc-multistore.com/Hobbywing-Quicrun-Fusion-Pro-Combo-fuer-Rock-Crawler-2300kV-HW30120402) |
| **Premium** | Hobbywing **Xerun AXE540 2300kV** motor + AXE R2 FOC ESC | Sensored brushless, serviceable | motor **€121.59** + ESC | [rc-multistore (motor)](https://www.rc-multistore.com/Hobbywing-Xerun-AXE540-FOC-Motor-fuer-Rock-Crawler-2300kV-HW30401252) |
| **Premium (enthusiast)** | Holmes Hobbies CrawlMaster V3 ESC + Revolver 540M | Reference sensored-brushless feel | ESC ~€104.90 | **Not on rc-multistore** → [elitehobby.eu](https://elitehobby.eu/en/brand/91-holmes-hobbies) (ES) or [holmeshobbies.co.uk](https://www.holmeshobbies.co.uk/) (UK, +import) |

**Top pick:** **Hobbywing QuicRun Fusion 1800kV** (run on 3S) or **Fusion Pro 2300kV
(€118.79)** if you also want trail speed — integrated, waterproof, strong 6A BEC to
feed a high-torque steering servo.

⚠️ **ESC/motor type must match.** The WP1080 is **brushed only** — never pair it with
a brushless motor. AXE / CrawlMaster / Furitek brushless ESCs are sensored-brushless
only. The Fusion combos are integrated, so this risk disappears.

---

## 2. Steering servo

Standard size fits (low-profile is nicer for cross-brace clearance). Spline is **25T**
(horn included with kit). Vanquish's own VS-1 is only ~14 kg·cm — weak for big tires;
**owner sweet spot is ~25–35 kg·cm at 7.4V**, all **waterproof, metal/steel gear, HV**.

| Tier | Pick | Torque @7.4V | EUR | Source |
|---|---|---|---|---|
| **Budget** ★ | **AMXRacing AMHV5830MG WP** | 30.3 kg·cm | **€53.09 (in stock)** | [rc-multistore](https://www.rc-multistore.com/AMEWI-AMXRacing-AMHV5830MG-WP-Standard-Servo-28998) |
| Budget alt | Power HD LW-25MG | ~25 kg·cm | €47–50 | [MonsterHopups.de](https://www.monsterhopups.de/Power-HD-LW-25MG-Servo-25kg-Aluminium-housing-Metal-gearbox-Waterproof-ball-bearing) / Lindinger |
| **Mid (best value)** | **Savox SW-1210SG+** | ~33–37 kg·cm | ~€75–85 | [EuroRC](https://www.eurorc.com/product/37400/savox-sw-1210sg-plus-digital-waterproof-hv-servo-012s37kg84v) / [rc-multistore Savox cat.](https://www.rc-multistore.com/Servos_2) |
| **Premium** | Reefs RC **Triple4** / **422HD V2** | ~30–31 kg·cm, IP67 | ~€95–130 (import) | [reefsrc.com](https://reefsrc.com/collections/servos) (thin EU stock) |

**Top pick:** **AMXRacing AMHV5830MG WP (€53, in stock at rc-multistore)** — 30 kg·cm,
waterproof, 25T, standard size, ships from the preferred shop. Step up to **Savox
SW-1210SG+** for a name-brand with more grunt.

⚠️ **BEC current:** a high-torque servo can stall-draw more than a weak ESC BEC
supplies. The Fusion/Fusion Pro (6A) and AXE handle it; with the small WP1080,
don't oversize the servo or add an external BEC/capacitor.
**Servo saver:** the VS4-10 steering link has no built-in saver — an inline/horn
servo saver is cheap insurance against stripped steering on a hard hit
([rc-multistore servo-saver cat.](https://www.rc-multistore.com/servo-saver)).

---

## 3. Battery + charger

Crawlers pull only a few amps, so **low C-rating is fine**. **2S is the crawler norm**
(smooth, plenty of torque); **3S** adds punch/speed if your ESC supports it. A
full-size hardcase stick pack fits the stock tray + Velcro straps (easiest, cheapest,
biggest capacity); shorty packs lower the CG but need an end-stop.

**Battery (rc-multistore, all in stock):**

| Tier | Pack | Cap / Connector | EUR |
|---|---|---|---|
| Budget 2S | ABSIMA 2S 7.4V 45C | 4000mAh, T-Plug | €17.96 |
| **2S pick** ★ | **ABSIMA 2S 7.4V 50C V2** | 5000mAh, T-Plug, hardcase (138×47×25mm) | **€22.46** |
| **3S pick** | ABSIMA 3S 11.1V 45C V2 | 5000mAh, T-Plug, hardcase | **€32.36** |

[rc-multistore LiPo category](https://www.rc-multistore.com/LIPO-Akkus-fuer-RC-Cars-Boote)

**Charger (AC built-in = plug straight into EU mains):**

| Tier | Charger | Range | EUR |
|---|---|---|---|
| Cheapest | SkyRC e3 | 2–3S only, 1.2A | €20.67 |
| **Pick** ★ | **SkyRC B6AC V2** | 1–6S, 6A, 50W AC | **€58.27** |
| Nicer | ISDT 608AC | 1–6S, 60W AC/200W DC | €62.03 |
| Dual-port | SkyRC D100 V2 | 1–6S, 100W | €127.99 |

[rc-multistore charger category](https://www.rc-multistore.com/Ladegeraete-Netzteile-Ladekabel-Zubehoer)
· Avoid DC-only units unless a 12V PSU is already on hand. EU fallbacks: EuroRC (FI),
HOTA D6 Pro / ToolkitRC M6.

⚠️ **Connector:** rc-multistore ABSIMA/Robitronic packs ship **T-Plug (Deans)**. Many
crawler ESCs use **XT60** — match them, or add a ~€4 T-Plug↔XT60 adapter, or re-solder.
Pick **one connector standard** across pack/ESC/charger.

**LiPo safety (include in every recommendation):** storage-charge to ~3.8 V/cell when
idle; charge at ≤1C, **attended, in a LiPo-safe bag**
([SLS bag ~€12 at rc-multistore](https://www.rc-multistore.com/SLS-LIPO-Akku-Lipo-Safe-Tasche-Lipo-Safety-Bag));
set ESC low-voltage cutoff ~3.3–3.5 V/cell; LiPos ship at ~30% charge by EU
regulation — charge before first use.

---

## 4. Tires (+ foams + glue) — wheels are already in the box

The kit ships with 1.9" Battle Born X-Ray wheels, so **buy tires only**. Target
**1.9 × ~4.6–4.75" OD**, soft/super-soft compound.

| Tier | Tire | Foams? | EUR | Source |
|---|---|---|---|---|
| **Budget (all-in-box)** ★ | **Louise CR-CHAMP / GRIFFIN / ROWDY 1.9" Super Soft** | **Included** | **€17.09** | [rc-multistore](https://www.rc-multistore.com/Crawler-Komplettraeder-Felgen-Reifen-Zubehoer) |
| Budget+ | Injora 1.9" S5 super-soft | Usually included | €12–20 | [injora.com](https://www.injora.com/collections/1-9-tires) / Amazon EU |
| Mid (scale realism) | RC4WD 1.9" (KM2 / Patagonia / Mud Slinger 2) | Included | ~€27.86 | [rc-multistore](https://www.rc-multistore.com/RC4WD-BFGoodrich-Mud-Terrain-T-A-KM2-19-Tires-RC4ZT0187) |
| **Premium (owner favorite)** ★ | **Pro-Line Hyrax 1.9" Predator, 4.75" OD** | **Sold separately** (+Pro-Line dual-stage foams) | ~€28–33 +€10 | [EuroRC (FI)](https://www.eurorc.com/) — not clearly stocked at rc-multistore |

**Glue (consumable, required):** Traxxas Ultra tire glue **€12.56**
([rc-multistore](https://www.rc-multistore.com/traxxas-trx-ultra-premium-reifenkleber-trx6468))
or Pro-Line Pro-Bond (~€10 at RC-HP.de). Thin CA, one tube does a set.

**Top pick:** **Pro-Line Hyrax Predator 4.75" + Pro-Line foams** (best owner-validated
grip; source from EuroRC). Cheapest no-extras route: **Louise CR-CHAMP Super Soft
(€17, foams included)** from rc-multistore.

*Optional wheel upgrade* (not needed): screw-clamp 1.9" beadlocks — Vanquish VPS
Method/Sierra, Pro-Line Impulse, or Injora (brass = useful rotating weight).

---

## 5. Transmitter + receiver (radio)

**Channel math for THIS truck:** steering + throttle = 2ch. Single-speed = **no shift
channel**. Add a **winch** (1ch, ideally 3-position) and **lights** (1ch) → **4ch is
the comfortable target**. Pistol-grip (wheel) is the conventional crawler form factor.
**Receivers are brand/protocol-specific** — one receiver per vehicle.

| Tier | Radio | Ch | RX included? | EUR | Source |
|---|---|---|---|---|---|
| **Budget** ★ | **Flysky FS-GT5** | 6 | Yes (FS-BS6, 6ch) | **€90.89** | [rc-multistore](https://www.rc-multistore.com/flysky-fs-gt5-sender-6-kanal-mit-1-empfaenger-fs054) |
| **Best value** ★ | **RadioMaster MT12** (wheel, EdgeTX, 16ch) — **4-in-1  version** | 16 | Yes (R85C, 5ch) | ~€155–175 | [rc-multistore radio cat.](https://www.rc-multistore.com/Handsender-Pultsender) (confirm stock) / [rc-hangar15.de](https://shop.rc-hangar15.de/RadioMaster-MT12-Surface-ELRS-16CH-Fernsteuerung-inkl-ER3C-I-Empfaenger-EU-LBT) / TekRC EU |
| **Premium** | Flysky **Noble NB4+/NB4-Pro+** (AFHDS3, touchscreen) | ~8 | NB4+ 1 RX / Pro+ 2 RX | from **€251.99** | [rc-multistore](https://www.rc-multistore.com/Flysky-Noble-NB4-Sender-mit-1-Empfaenger-FS002P) |

**Top pick:** **RadioMaster MT12, 4-in-1 version with the R85C (5ch) receiver** —
plug-and-play winch + lights with channels to spare, EdgeTX mixing, huge value. If
buying the **ELRS** MT12 instead, its bundled ER3C-i is only 3ch — add an **ER4 (~€20)**
or **ER6 (~€32)**. Cheapest solid option: **Flysky FS-GT5 (€90.89, RX included)**.

---

## Sample builds (kit + everything to drive it)

Component subtotals **exclude** the €854.99 kit. Verify all prices before buying.

### A. Budget — one-stop-shop from rc-multistore (~€335 + kit ≈ €1,190)
- Motor+ESC: Hobbywing WP1080 Combo 540/30T — €68.90
- Servo: AMXRacing AMHV5830MG WP — €53.09
- Battery: ABSIMA 2S 5000mAh — €22.46
- Charger: SkyRC B6AC V2 — €58.27
- Tires: Louise CR-CHAMP Super Soft — €17.09
- Glue: Traxxas Ultra — €12.56
- Radio: Flysky FS-GT5 (RX incl.) — €90.89
- LiPo-safe bag — ~€12

### B. Recommended — best all-round (~€525 + kit ≈ €1,380)
- Motor+ESC: Hobbywing QuicRun **Fusion Pro 2300kV** — €118.79
- Servo: **Savox SW-1210SG+** — ~€80
- Battery: ABSIMA **3S** 5000mAh — €32.36
- Charger: ISDT 608AC — €62.03
- Tires: **Pro-Line Hyrax Predator 4.75"** + foams (EuroRC) — ~€43
- Glue: Traxxas Ultra — €12.56
- Radio: **RadioMaster MT12 (4-in-1 + R85C)** — ~€165
- LiPo-safe bag — ~€12

### C. Premium — best-of-breed (~€860 + kit ≈ €1,715)
- Motor+ESC: Hobbywing **Xerun AXE540 2300kV + AXE R2** — ~€230
- Servo: **Reefs RC Triple4** (import) — ~€120
- Battery: 2× ABSIMA 3S 5000mAh — ~€65
- Charger: SkyRC D100 V2 — €127.99
- Tires: Pro-Line Hyrax + foams — ~€43
- Glue — €12.56
- Radio: Flysky **Noble NB4+** — €251.99
- LiPo bag — ~€12
- *Optional:* servo winch (Injora INJS035-360, ~€35) + beadlock wheels

### D. Performance — dig + selectable overdrive + high-voltage sensored + Spektrum (~€1,020 + kit ≈ €1,875)

For the owner who wants **best-in-class slow-speed control AND a fast (~15 km/h) mode**,
a **dig**, **more overdrive**, a **sensored** drivetrain, **maximum battery voltage**, a
**Spektrum** radio, and **powerful servos**. Assumes you already own a multi-cell LiPo
charger (e.g. **Robitronic Expert LD 80**, 1–6S/80W — charges 3S & 4S, no new charger).

- **Transmission upgrade (the key part):** **Vanquish VFD Twin Transmission Kit
  (VPS10200)** — ~€204 ([game-mania.it](https://game-mania.it/index.php?cPath=65_125_579&language=en&main_page=product_info&products_id=18490); ⚠️ not at rc-multistore). Replaces the kit's single VFD; gives
  **on-the-fly selectable overdrive 6.5% ↔ 46%** (your "fast mode"), a **neutral =
  front-disconnect/2WD**, **and a built-in 3-position dig**. ⚠️ *Not a true 2:1 high
  gear* — 46% OD ≈ 1.4× wheel speed; the rest of ~15 km/h comes from motor KV × volts.
  - Dig/OD servo mount: **VS4-10 Cross-Brace w/ Dig Servo Mount (VPS10126)** ~€25
  - **2× low-profile shift servos** (overdrive + dig), ~€25 ea — need **2 aux channels**
  - *Optional extra overdrive:* front-axle 24T/8T helical set (~22% OD), aftermarket ~€20
  - *Dig-only alternative* (keep stock VFD, no fast-mode OD): VFD **Hurtz Dig**
    VPS01360 (~$110, in stock AMain) + 1 servo + 1 channel
- **Motor+ESC (sensored, max-voltage, strong BEC):** **Castle Mamba X crawler combo,
  1406-1900kV** — ~€195 (EuroRC). Sensored SmartSense, **2–6S**, **8A adjustable BEC**.
  - 4S-capable; run **3S + ~1900–2300kV** for the easy crawl+15 km/h balance, or **4S +
    ~1400–1500kV** for true max voltage (under-KV the motor to keep crawl + manage heat).
  - One-cart Hobbywing alt (**3S max**): Xerun **AXE R2 + AXE540 2300kV** (€121.59 motor
    + ESC). For genuine **4S** in the Hobbywing family you must use the **AXE Plus R3
    (2–6S)** combo (~€237, EuroRC) — the **AXE R2 is 3S-only**.
- **Steering servo (powerful HV):** **Savox SW-2290SG** waterproof monster — €129.99
  (Lindinger AT, in stock). ~50 kg·cm@7.4V (up to ~65–70@8.4V), 25T, standard size (use
  a low-profile horn). Lighter-draw alt: Savox SW-1210SG+ (~37 kg·cm).
- **Radio (Spektrum, dig + 2-speed):** **Spektrum DX5 Rugged + SR515** — €284.99
  (rc-multistore). 5ch, **weatherproof**, **RX included**, assignable mixing for
  servo-shifted OD + dig. Channel map: steering · throttle · OD-shift · dig · lights.
  - Need a winch too (6ch + AVC + telemetry)? DX5 Rugged TX-only + **SR6100AT** (€104.49),
    or step to the **DX6R** (€349.99 TX-only) + SR6100AT.
- **Battery (max voltage):** 4S 5000mAh hardcase **XT60** (~€89, EuroRC) for the 4S path,
  or ABSIMA **3S** 5000mAh XT60 (€32.36, rc-multistore) for the simpler build.
  - **Charger:** your **Robitronic Expert LD 80** (1–6S/80W/7A, AC+DC) — covers 3S & 4S.
- **Tires/glue:** Pro-Line Hyrax Predator 4.75" + foams (~€43) or Louise CR-CHAMP (€17) + glue €12.56.
- **External BEC + servo saver:** ~€30. ⚠️ A monster steering servo + 2 shift servos can
  exceed a 6A BEC at simultaneous stall — the Mamba X's 8A helps, but add an external
  7.4V/8A BEC (or at least a glitch capacitor). The VS4-10 steering has no built-in saver.

> **Voltage reality:** the **ESC is the voltage ceiling, not the charger or battery.**
> The default Fusion Pro is **3S-only** — never run 4S on it. Only 2–6S ESCs (Mamba X,
> AXE Plus R3) make 4S real. 6S is overkill for a 313 mm crawler (heat/weight, no crawl
> gain). **15 km/h math:** 2300kV-on-3S tops ~11–12 km/h; reach ~15 km/h via the 46%
> overdrive and/or a ~2700–3200kV motor, or 4S with a lower-KV motor.

---

## Optional / nice-to-have

- **Scale winch** — the Origin can mount one. A **servo winch** (e.g. Injora
  INJS035-360, 35 kg, 360°, ~€35) gives real pulling power; needs a free aux channel
  + winch controller. Casual trail = a dummy/kinetic winch is fine.
- **Beadlock wheels** (see §4) if you want screw-clamp wheels over the included
  glue-on SLW wheels.
- **Body paint** — the body is clear Lexan: needs polycarbonate paint (e.g. Tamiya PS),
  window masks, and prep.
- **Spares/tools** — 25T low-profile servo horn, hex drivers, threadlock (some
  included), shock oil (30wt included).

---

## Compatibility & ordering checklist (run before paying)

- [ ] **Wheel size = 1.9"** tires (NOT 2.2"); ~4.6–4.75" OD.
- [ ] **Motor/ESC type matches** (brushed ESC ↔ brushed motor; brushless ESC ↔
      sensored brushless motor). Integrated Fusion combo avoids the issue.
- [ ] **Cell count:** chosen ESC supports your 2S or 3S pack.
- [ ] **Battery connector** matches ESC (T-Plug vs XT60) — else buy an adapter/re-solder.
- [ ] **Servo:** 25T spline (yes for all picks), waterproof, and your **ESC's BEC can
      feed it** at stall.
- [ ] **Radio ↔ receiver same brand/protocol**; ≥4 channels (steering, throttle,
      winch, lights). One RX per vehicle.
- [ ] **Foams:** included with Louise/RC4WD/Injora; **buy separately for Pro-Line**.
- [ ] **Tire glue** in the cart.
- [ ] **Kit in stock?** VPS09026B was out of stock at rc-multistore — confirm before
      committing the rest of the order.
- [ ] **Charger is AC** (EU mains) unless you own a 12V PSU; add a **LiPo-safe bag**.
- [ ] **Body paint** if you don't want a clear body.

---

## rc-multistore one-stop-shop verdict

rc-multistore (Friesenheim, DE; EUR; PayPal/Klarna/card; 14-day return; DE shipping
€4.99–5.90, **EU rates/free-ship threshold not published — confirm at checkout**) can
supply **almost the whole build**: kit (when in stock), Hobbywing motor/ESC combos,
AMXRacing servo, ABSIMA battery, SkyRC/ISDT charger, Louise/RC4WD tires, tire glue,
Flysky radios, LiPo bag. **Likely gaps:** Pro-Line Hyrax tires, Reefs/Holmes premium
parts, and confirmed MT12 stock — fill from **EuroRC (FI)**, elitehobby.eu, rc-hangar15.de,
or TekRC EU. So: **Budget build A = genuinely one cart**; Recommended/Premium = mostly
rc-multistore + one or two specialist EU orders.

---

## Sources

- [Vanquish VS4-10 Origin Classic Pro (official spec)](https://vanquishproducts.com/products/vs4-10-origin-classic-pro)
- [rc-multistore kit page (VPS09026B)](https://www.rc-multistore.com/Vanquish-VS4-10-Origin-Classic-Pro-Kit-Black-Axles-VPS09026B)
- Motor/ESC: [WP1080 combo](https://www.rc-multistore.com/Hobbywing-Quicrun-Brushed-WP1080-Combo-540-30-Turn-HW38020349) · [Fusion Pro 2300kV](https://rc-multistore.com/Hobbywing-Quicrun-Fusion-Pro-Combo-fuer-Rock-Crawler-2300kV-HW30120402) · [AXE540 motor](https://www.rc-multistore.com/Hobbywing-Xerun-AXE540-FOC-Motor-fuer-Rock-Crawler-2300kV-HW30401252) · [Holmes Hobbies @ elitehobby.eu](https://elitehobby.eu/en/brand/91-holmes-hobbies)
- Servo: [AMXRacing AMHV5830MG WP](https://www.rc-multistore.com/AMEWI-AMXRacing-AMHV5830MG-WP-Standard-Servo-28998) · [Savox SW-1210SG+ @ EuroRC](https://www.eurorc.com/product/37400/savox-sw-1210sg-plus-digital-waterproof-hv-servo-012s37kg84v) · [Reefs RC servos](https://reefsrc.com/collections/servos)
- Battery/charger: [rc-multistore LiPo cat.](https://www.rc-multistore.com/LIPO-Akkus-fuer-RC-Cars-Boote) · [charger cat.](https://www.rc-multistore.com/Ladegeraete-Netzteile-Ladekabel-Zubehoer) · [LiPo-safe bag](https://www.rc-multistore.com/SLS-LIPO-Akku-Lipo-Safe-Tasche-Lipo-Safety-Bag)
- Tires/glue: [rc-multistore crawler tire cat.](https://www.rc-multistore.com/Crawler-Komplettraeder-Felgen-Reifen-Zubehoer) · [RC4WD KM2 1.9"](https://www.rc-multistore.com/RC4WD-BFGoodrich-Mud-Terrain-T-A-KM2-19-Tires-RC4ZT0187) · [Traxxas tire glue](https://www.rc-multistore.com/traxxas-trx-ultra-premium-reifenkleber-trx6468) · [Pro-Line Hyrax](https://www.prolineracing.com/product/1-10-hyrax-g8-front-rear-1.9-rock-crawling-tires-2/PRO1012814.html) · [EuroRC](https://www.eurorc.com/)
- Radio: [Flysky FS-GT5](https://www.rc-multistore.com/flysky-fs-gt5-sender-6-kanal-mit-1-empfaenger-fs054) · [RadioMaster MT12 (official)](https://radiomasterrc.com/products/mt12-surface-radio-controller) · [Flysky Noble NB4+](https://www.rc-multistore.com/Flysky-Noble-NB4-Sender-mit-1-Empfaenger-FS002P)
- Winch: [VS4-10 servo-winch install writeup](https://km1ndy.com/servo-winch-on-vanquish-vs4-10-crawler/)

> Prices/stock researched ~June 2026 across rc-multistore.com, vanquishproducts.com,
> EuroRC, RCCrawler, Scale Builders Guild, and brand sites. **Re-verify before
> ordering.** This is a buying guide, not affiliated with any retailer.
