# Orogen research: terrain erosion and hydrology algorithms for WGSL compute shaders

Date of research: 2026-10-12. Target: WebGPU/WGSL compute on grid heightfields up to 8129 x 8129, `r32float`.

## 0. How to read this report

### 0.1 Evidence labels

Every load-bearing claim carries one of these tags.

| Tag | Meaning |
|---|---|
| **[V]** | Verified in this session against a primary source (paper PDF text, official docs page, or the source code of the reference implementation). |
| **[S]** | Secondary source only (abstract, search snippet, third-party summary). Treat as probable. |
| **[D]** | Derived or designed by the author of this report (analysis, arithmetic, or an engineering recommendation). Not taken from a source. Needs testing. |
| **[U]** | UNVERIFIED. From memory or could not be checked. Do not hard-code without checking. |

### 0.2 Sources I could not open (affects what is [V])

| Source | Problem | Consequence |
|---|---|---|
| Schott et al. 2023 paper PDF (HAL `hal-04049125`, ACM DL) | bot-protection / 403 | All Schott 2023 facts come from the released shader `spe_shader.glsl` and host code, which I read. Paper-level iteration counts and timings are not in this report. |
| Schott et al. 2024 paper PDF (HAL `hal-04565030`) | bot-protection | Facts come from the three released shaders and the README. |
| Cordonnier et al. 2016 PDF (Purdue copy) | larger than fetch limit | Described only through later papers that cite it. |
| Cordonnier et al. 2023 "Forming Terrains by Glacial Erosion" | abstract only | Glacier section relies on Argudo et al. 2020 shader instead. |
| Beyer 2015 thesis (`firespark.de`) | expired TLS certificate | Droplet model taken from Sebastian Lague's code, which implements it. |
| Shadertoy pages (terms, `MtGcWh`, `7ljcRW`) | 403 | Licences of the Clay John and Fewes shaders are UNVERIFIED. |
| Inria GitLab (`fastflow`, `debrisflow`, `analytical-terrains`) | bot-protection | Licences of those three repos are UNVERIFIED. |
| Nilles et al. VMV 2024 PDF, Paris et al. 2019 PDF, Argudo et al. 2020 PDF | 403 / 404 / 503 | Used abstract (VMV), source code (Paris, Argudo). |
| WGSL spec sections on float accuracy and atomics | page truncated by fetch tool | WGSL numeric claims are [U] or [S]. |

### 0.3 Notation

- Grid `N x N`, cell size `dx` in metres (world units). `L = N*dx` is the world extent.
- `b` terrain (bedrock + regolith) height, `d` water depth, `s` suspended sediment (stored as equivalent height in metres), `z` generic surface elevation, `A` drainage area (m^2), `Q` discharge (m^3/yr), `S` slope (dimensionless rise over run).
- Neighbour sets: N4 (von Neumann), N8 (Moore). `dist(i,j)` is `dx` for axial neighbours and `sqrt(2)*dx` for diagonals.

### 0.4 WebGPU facts that shape every pass design

| Fact | Value | Tag |
|---|---|---|
| Default `maxTextureDimension2D` | 8192, so 8129 fits without raising limits | [V] MDN GPUSupportedLimits, https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits |
| Default `maxStorageTexturesPerShaderStage` | 4 | [V] same |
| Default `maxStorageBuffersPerShaderStage` | 8 | [V] same |
| Default `maxStorageBufferBindingSize` | 134,217,728 bytes (128 MiB) | [V] same |
| Default `maxBufferSize` | 268,435,456 bytes (256 MiB) | [V] same |
| Default `maxComputeInvocationsPerWorkgroup` | 256 (so 16x16 is the largest square workgroup) | [V] same |
| `read-only` / `read-write` storage texture access | requires WGSL language feature `readonly_and_readwrite_storage_textures`; default access is `write-only` | [V] MDN createBindGroupLayout, https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createBindGroupLayout |
| `r32float` linear filtering | needs optional feature `float32-filterable`; otherwise bind as `unfilterable-float` and use `textureLoad` | [S] Chrome 119 release notes as returned by search, https://developer.chrome.com/blog/new-in-webgpu-119 |
| `read_write` storage is limited to `r32float`, `r32uint`, `r32sint` | | [U] from memory of the WebGPU format table; confirm |
| WGSL `atomic<T>` exists only for `i32` and `u32` (no float atomics) | | [U] from memory; confirm. Consequence: scatter-style accumulation needs fixed point or a CAS loop, so this report prefers gather formulations everywhere. |
| Workgroup size used by reference GPU implementations | 8x8 (Schott; WebGPU port found no gain beyond 8x8) | [V] `spe_shader.glsl`; https://github.com/GPU-Gang/WebGPU-Erosion-Simulation |

Memory arithmetic [D]:

| Resolution | cells | one `r32float` plane | one `rgba32float` |
|---|---|---|---|
| 1024^2 | 1,048,576 | 4 MiB | 16 MiB |
| 4096^2 | 16,777,216 | 64 MiB | 256 MiB |
| 8129^2 | 66,080,641 | 252.1 MiB | 1008.3 MiB |

Consequences [D]:
- An 8129^2 `r32float` plane as a storage *buffer* (264,322,564 bytes) exceeds the default 128 MiB binding limit. Use textures, or request a higher `maxStorageBufferBindingSize`.
- Readback of one 8129^2 `r32float` texture: `bytesPerRow` must be a multiple of 256, 8129*4 = 32,516 rounds up to 32,768, total about 266.3 MB, which is just under the default 256 MiB (268.4 MB) `maxBufferSize`. It fits with about 2 MB to spare; do not add a second channel.
- With only 4 storage textures per pass, design each pass as "many sampled inputs via `textureLoad`, at most 4 storage outputs".
- Purely local updates (read own texel, write own texel) can run in place on `r32float` with `read_write` access and need no ping-pong. Anything that reads a neighbour of a texture it also writes needs ping-pong or a delta texture.

---

## 1. Virtual-pipe shallow-water hydraulic erosion

Primary sources: Mei, Decaudin, Hu 2007 (PDF text read: http://evasion.inrialpes.fr/Publications/2007/MDH07/FastErosion_PG07.pdf); Stava et al. 2008 (https://www.cs.purdue.edu/homes/bbenes/papers/Stava08SCA.pdf); Jako and Toth 2011 (https://www.old.cescg.org/CESCG-2011/papers/TUBudapest-Jako-Balazs.pdf).

### 1.1 Per-cell state

`b` terrain height, `d` water depth, `s` suspended sediment, outflow flux `f = (fL, fR, fT, fB)`, velocity `v = (u, v)`. [V] Mei 2007 section 3; Jako 2011 section 2.

### 1.2 Update equations, in order

Step order from Mei 2007 [V]: water increment, flow simulation, erosion-deposition, sediment transport, evaporation. Mei implements it as 7 fragment passes (1 + 3 + 1 + 1 + 1). [V]

**(1) Rain / sources** [V] Mei eq. 1, Jako eq. 1
```
d1 = d + dt * r(x,y) * Kr
```

**(2) Outflow flux** [V] Mei eq. 2-5
```
dhL  = (b + d1) - (b_left + d1_left)          // same for R, T, B
fL'  = max(0, fL + dt * A * g * dhL / l)
K    = min(1, d1 * lx * ly / ((fL' + fR' + fT' + fB') * dt))
f'   = K * f'
```
- `A` pipe cross-section, `l` pipe length, `lx, ly` cell spacing.
- Jako 2011 eq. 4 prints `max(1, ...)`. That is a typo; Mei 2007 eq. 4 is `min`, and the purpose (prevent negative water) only works with `min`. [V] both PDFs read.
- Boundary: Mei sets the outward flux of border cells to zero (closed box). [V]
- Stava 2008 fixes `l = 1 m` and cross-section `C = l^2`. [V]

**(3) Water depth** [V] Mei eq. 6-7
```
dV = dt * (fR(x-1,y) + fT(x,y-1) + fL(x+1,y) + fB(x,y+1) - (fL+fR+fT+fB)(x,y))
d2 = d1 + dV / (lx * ly)
```

**(4) Velocity** [V] Mei eq. 8-9
```
dWx  = 0.5 * (fR(x-1,y) - fL(x,y) + fR(x,y) - fL(x+1,y))
dbar = 0.5 * (d1 + d2)
u    = dWx / (ly * dbar)          // v analogous with lx
```
Stava 2008 uses the same form with the mean of the water heights of the last two steps. [V]

**(5) Sediment capacity**
```
C = Kc * sin(alpha) * |v|                         // Mei eq. 10 [V]
C = Kc * sin(alpha) * |v| * lmax(d1)              // Jako eq. 10 [V]
lmax(x) = 0                    if x <= 0
        = 1                    if x >= Kdmax
        = 1 - (Kdmax - x)/Kdmax  otherwise        // a 0..1 ramp
```
- Mei: clamp `alpha` from below with a user threshold, otherwise flat areas never erode. [V]
- Jako variant with surface normal: `C = Kc * (-N . V) * |v| * lmax(d1)`. [V] eq. 11
- Note that Jako's ramp *increases* capacity with depth up to `Kdmax` and then saturates. The paper's prose describes it as limiting erosion in deep water, which does not match the printed formula. [V] that the formula is as written; treat the intent as ambiguous.
- Stava: capacity constant per material, 0.0001 (rock) to 0.1 (sand). [V]

**(6) Erosion / deposition** [V] Jako eq. 12a-13c (preferred over Mei eq. 11-12 because Jako multiplies by `dt`)
```
if C > s:  e = dt * R * Ks * (C - s);   b -= e;  s += e;  d += e
else:      p = dt * Kd * (s - C);       b += p;  s -= p;  d -= p
```
- Mei's original has no `dt` factor and does not touch `d`. [V] The missing `dt` makes `Ks`, `Kd` time-step dependent; use Jako's form.
- The `d += e` / `d -= p` terms are Jako's fix for long-run ripples on the water surface. [V]
- Jako clamps the dissolved amount to the available water height. [V]
- `R` is a per-cell erodibility in 0..1. Jako's text is internally inconsistent about whether a larger `R` is harder or softer, and eq. 14 lowers `R` on deposition while the prose says sediment gets softer. [V] that the inconsistency exists. Recommendation [D]: define `R` as erodibility (1 = soft), and model soft deposited material with an explicit sediment layer instead of mutating `R`.

**(7) Sediment advection**
```
s(x,y) = s1(x - u*dt, y - v*dt)     // semi-Lagrangian, bilinear   [V] Mei eq. 14, Jako eq. 15
```
- Stava 2008 replaces this with semi-Lagrangian MacCormack for less numerical diffusion. [V]
- LanLou123's WebGL implementation added MacCormack for sediment and semi-Lagrangian self-advection of the velocity field. [V] https://github.com/LanLou123/Webgl-Erosion

**(8) Evaporation** [V] Mei eq. 15
```
d = d2 * (1 - Ke * dt)
```

### 1.3 Parameters with published values

Jako and Toth 2011, Table 2 (cell size implicitly 1) [V]:

| Symbol | Meaning | Range | Typical |
|---|---|---|---|
| dt | time increment | 0 to 0.05 | 0.02 |
| Kr | rain rate | 0 to 0.05 | 0.012 |
| Ke | evaporation rate | 0 to 0.05 | 0.015 |
| A | pipe cross-section | 0.1 to 60 | 20 |
| g | gravity | 0.1 to 20 | 9.81 |
| Kc | sediment capacity | 0.1 to 3 | 1 |
| Ks | suspension (dissolving) rate | 0.1 to 2 | 0.5 |
| Kd | deposition rate | 0.1 to 3 | 1 |
| Kh | sediment softening rate | 0 to 10 | 5 |
| Kdmax | maximal erosion depth | 0 to 40 | 10 |
| Kt | thermal erosion rate | 0 to 3 | 0.15 |
| Ka | talus tangent coefficient | 0 to 1 | 0.8 |
| Ki | talus tangent bias | 0 to 1 | 0.1 |

Mei 2007 Table 1: time step halves every time the grid doubles on a fixed domain: 0.002 at 256^2, 0.001 at 512^2, 0.0005 at 1024^2, 0.00025 at 2048^2, 0.000125 at 4096^2. Simulation cost 6.65 ms/step at 1024^2 and 91.2 ms/step at 4096^2 on a GeForce 8800 GTX. [V]

A modern data point: a multi-layer extension of the pipe model reports about 6 ms/step at 2048^2 and 23 ms/step at 4096^2 on an RTX 3070 (Nilles et al., VMV 2024). [S] abstract, https://diglib.eg.org/handle/10.2312/vmv20241211

### 1.4 Stability

- Mei's stated limit is the advective CFL condition `dt*u <= lx`, `dt*v <= ly`, and they note the flux scaling by `K` is itself a source of instability because neighbour fluxes are not corrected. [V]
- Gravity-wave bound [D]. Linearising steps (2)-(3) gives a wave equation with speed `c^2 = A*g/l`. Note the speed does not depend on water depth when `A` is constant. For the explicit update order used here the 2D limit is `c*dt/l <= 1/sqrt(2)`, i.e.
  ```
  dt_max = sqrt( l^3 / (2 * A * g) )
  ```
  Check against Jako's table: `A = 20, g = 9.81, l = 1` gives `dt_max = 0.0505`, which matches the upper end of their allowed range (0.05) [V range]. Because the two opposing one-way fluxes on an edge can both change during a flow reversal, use a safety factor of 0.5: `dt = 0.5 * dt_max` (0.025 with Jako's numbers; their typical value is 0.02).
- With `A = l^2` (Stava): `dt_max = sqrt(l / (2g)) = 0.226 * sqrt(l)` seconds. [D]
- Number of steps for a gravity wave to cross the grid: `N * sqrt(2) / safety`, about `2.8 * N` at safety 0.5, independent of `l`, `A`, `g`. [D] This is the basic reason iteration counts scale with grid width.
- Guard the velocity division: if `dbar < d_min` set `v = 0`. [D]
- Limit erosion per step so a cell cannot drop below its lowest N4 neighbour. [D] (Same idea as the receiver clamp in Schott's stream-power shader, [V].)

### 1.5 Known artefacts and fixes

| Artefact | Cause | Fix | Tag |
|---|---|---|---|
| Regular ripples on water and sea floor in long runs | terrain changed by erosion without matching change in water column | add eroded amount to `d`, subtract deposited amount (eq. 12c / 13c) | [V] Jako |
| Riverbeds carved unrealistically deep, pits | capacity unbounded where velocity is high | depth ramp `lmax(d)`; one student implementation multiplies capacity by `clamp(d, 0, 1)` so that a tiny film of water cannot dissolve a lot | [V] Jako; [V] https://huw-man.github.io/Interactive-Erosion-Simulator-on-GPU/ |
| Positive feedback: deep narrow valleys and steep peaks | erosion deepens the channel that already has the flow | extrema-limiting smoothing pass at the end of each cycle; combine with thermal erosion every step | [V] huw-man; [V] Jako (thermal inside the loop, order: flow, thermal outflow, erosion, advection, thermal apply, evaporation) |
| Noise / speckle in the sediment field | advection through cells with almost no water | exclude small water bodies from sediment advection | [V] LanLou123 README |
| No erosion on flat ground | `sin(alpha)` tends to 0 | lower bound on `alpha` | [V] Mei |
| Sediment mass not conserved | semi-Lagrangian advection is not conservative | accept, or use flux-form upwind advection: sediment carried by each pipe is `f_i * s/d` of the upwind cell; gather form, exactly conservative, reuses the flux textures | [V] LanLou notes the loss; fix is [D] |
| Numerical diffusion of sediment | first-order semi-Lagrangian | MacCormack | [V] Stava; LanLou |
| Axis-aligned or 45-degree channels | N4 pipes, perfectly symmetric input | (a) break symmetry with a noisy erodibility map (Jako builds `R` from scaled height plus noise, then blurs it [V]); (b) estimate slope with an isotropic gradient (Sobel/Scharr) rather than max neighbour difference [D]; (c) velocity self-advection gives the water momentum and produces larger-scale meandering [V] LanLou; (d) N8 pipes are possible, Mei says the equations extend to 8 neighbours but found N4 satisfactory [V] | mixed |
| Checkerboard in `b` | collocated grid, erosion decided from a central-difference velocity, time step too large | Jako's 12c/13c fix, `dt` bound from 1.4, thermal relaxation each step, optional tiny Laplacian on `b` weighted by the erosion amount | [V] first item; rest [D] |
| Single-cell spikes of deposit | all suspended sediment dropped where water disappears | deposit at rate `Kd` only, never instantly; cap deposition so the cell does not rise above the mean of its upstream neighbours (Jain et al. 2024 use this cap in their stream-power solver [V]); thermal pass | [D] by analogy |
| Narrow channels only, no wide ones | uniform rain plus feedback | vary smoothing, use sources and non-uniform rain | [V] huw-man |

### 1.6 Recommended WGSL pass structure [D]

All planes `r32float`. In-place passes use `read_write` storage.

| Pass | Reads (sampled, `textureLoad`) | Writes (storage) | In place? |
|---|---|---|---|
| P1 flux | `b`, `d` (self + N4) | `fL, fR, fT, fB` (read_write, 4 storage) | yes, each cell reads only its own old flux |
| P2 water + velocity + capacity | `fL..fB` (self + N4), `b` (N8 for slope), rain mask | `d` (read_write), `u`, `v`, `C` | yes for `d` |
| P3 erosion / deposition | `C`, `u`, `v`, erodibility | `b`, `s`, `d` (read_write), `E` cumulative erosion (read_write) | yes, fully local because slope was folded into `C` in P2 |
| P4 sediment advection | `s`, `u`, `v` (or fluxes for flux-form) | `s'` | no, ping-pong `s` / `s'` |
| P5 thermal (every k-th step) | `b` (N8), talus map | `b'` | no, ping-pong `b` / `b'` |

- 4 passes per iteration plus thermal, against 7 in Mei [V].
- Rain and evaporation are folded into P2: `d = (d + dV/l^2) * (1 - Ke*dt) + dt*r`.
- Planes: `b, b', d, s, s', fL, fR, fT, fB, u, v, C, E` = 13, plus erodibility and rain mask. 13 planes are 52 MiB at 1024^2, 832 MiB at 4096^2, 3.3 GiB at 8129^2.
- Outputs: wear = `E`; deposits = `(b_final - b_initial) + E`; flow = running mean of `|v| * d`.
- Boundary: closed (Mei) or open. For a terrain tool use open edges: treat the outside as slightly lower dry ground so water and sediment leave the map. [D]

---

## 2. Thermal erosion / talus

### 2.1 Published formulations

**Jako and Toth 2011** [V] (cleaned up; the printed set definition has sign and `tan` typos)
```
H      = max over N8 of (b - b_i)
dS     = a * dt * Kt * R * H / 2              // a = cell area; H/2 is the maximum, more oscillates
talus  = R * Ka + Ki                           // tangent of the talus angle, depends on hardness
Aset   = { i in N8 : b_i < b  and  (b - b_i)/dist_i > talus }
dS_i   = dS * (b - b_i) / sum_{k in Aset} (b - b_k)
```
Executed as "virtual pipes": pass 1 writes the 8 outflows, pass 2 sums inflow minus outflow. Defaults `Kt = 0.15, Ka = 0.8, Ki = 0.1`. [V]

**Stava et al. 2008**, per neighbour pair [V] eq. 5
```
dd = dt * (dh - l * tan(alpha))   if dh > l * tan(alpha), else 0
```
Dry sand talus 30 degrees. With layers, slippage is processed bottom-to-top because a moving layer carries everything above it. [V]

**Axel Paris, blog** (2018, 2020) [V] https://perso.liris.cnrs.fr/aparis/public_html/posts/terrain_erosion.html and `terrain_erosion_2.html`
- Scatter version (cell pushes to its steepest neighbour) races on GPU. Three workarounds: integer buffer with atomics, float bits through an int buffer, or just ignore the race.
- Race-free version: each cell reads its 3x3 neighbourhood, adds a fixed `amplitude` if any neighbour is above the threshold relative to it, subtracts it if it is above any neighbour; double buffer. Reported 4 to 5 times slower than the racy version but deterministic.
- Constants: `tanThresholdAngle = 0.6` (about 31 degrees), amplitude 0.05 to 0.1 m.

**Schott et al. 2024 `thermal.glsl`** [V] https://github.com/H-Schott/MultiScaleErosion
- Count-based gather: `out = in + eps*cellArea * (nReceive - nDistribute)` over N8, `eps = 5e-5`, threshold tangent 0.57, optionally a noise-varied tangent between 0.9 and 1.4 driven by 3D simplex noise of position and height.

**Nilles et al. 2024 avalanching** (dunes, but a general talus solver) [V] https://scitepress.org/publishedPapers/2024/123156/pdf/index.html
```
B(i,j) = max( (slope(i->j) - tan(theta)) * dist(i,j), 0 )      // height excess toward j
B_A    = min( Bmax / (1 + Bmax/Bsum), s(i) )                   // total moved out of cell i
give_j = k_c * B(i,j)/Bsum * B_A                               // k_c = 1, 0.5 on some iterations
```
The total is chosen so the steepest neighbour lands exactly at repose. Iterations per simulation step scale linearly with resolution: 13-15 at 512, 25-31 at 1024, 50-62 at 2048, 100-125 at 4096. [V]

### 2.2 Recommended parallel-safe gather formulation [D]

Key observation (also used by Nilles for reptation [V]): if the transfer along an edge depends only on the two end heights, it is antisymmetric, so each cell can compute its own net change from a 3x3 read with no writes to neighbours and no atomics.

```
// T2: single pass, ping-pong b -> b'
q(i,j)  = c * w_j * max(0, (b_i - b_j) - talus_ij * dist(i,j))   // amount i gives to j
b'_i    = b_i + sum_{j in N8} ( q(j,i) - q(i,j) )
```
- `talus_ij` must be symmetric in `i, j` (for example the mean or min of the two cells' talus tangents), otherwise mass is not conserved.
- `w_j` = 1 for axial, `1/sqrt(2)` for diagonal neighbours.
- Stability: in the uniform worst case (8 lower neighbours with equal excess) no overshoot requires `c <= 1/9`. Use `c = 0.1`. For N4 use `c <= 1/5`.
- Conservation is exact up to float summation order, because `q(i,j)` is evaluated from identical inputs by both cells.

Layered case (a mobile layer `s` over fixed bedrock, used for sand, snow, debris):
```
// T1: per-cell limiter               (writes K, one r32float)
out_i = sum_j q(i,j);   K_i = min(1, s_i / max(out_i, tiny))
// T2: gather with limiter             (reads K of neighbours)
s'_i  = s_i + sum_j ( K_j * q(j,i) - K_i * q(i,j) )
```
This is the same two-pass pattern as the pipe model's `K` factor.

### 2.3 Hardness and strata [D unless tagged]

- Per-cell talus from hardness: `tan(theta) = R*Ka + Ki` (Jako, [V]).
- Strata: make hardness a function of absolute elevation through a 1D profile texture, `R = strata(z + tilt . xy + warp(xy))`. Evaluate with the *current* `b`, so when a soft band is removed the harder band below is exposed. Feed the same `R` to hydraulic `Ks` and stream-power `k`.
- Explicit layers (bedrock, sediment, debris with different talus and erodibility) follow Benes and Forsbach as used in Stava [V] and Jain et al. 2024 [V]: erosion removes from the top layers first; deposition always goes to the top layer.
- Iteration scaling: material moves at most one cell per iteration, so relaxing a cliff of height `Hc` needs at least `Hc / (tan(theta) * dx)` iterations; because the scheme is diffusive, large features need more. Use the coarse-to-fine driver in section 8. Anchor: Nilles' counts scale linearly with `N` [V].

---

## 3. Large-scale fluvial erosion: stream power law (SPL)

### 3.1 Model

```
dz/dt = u - k * A^m * S^n                       // basic SPL          [V] FastFlow eq. 2 (with n = 1)
dz/dt = u - k * Q^m * S^n + kd * Qs / Q         // with deposition    [V] FastFlow eq. 5, Jain 2024 eq. 1
H     = kh * laplacian(z)                       // hillslope diffusion [V] Jain eq. 4, Tzathas eq. 23
Eth   = kt * max(0, S - tan(theta_c))           // thermal as a rate   [V] Jain eq. 8, Tzathas eq. 27
Q     = integral of precipitation over upstream area;  Qs = upstream integral of net erosion   [V] Jain eq. 2-3
```

### 3.2 Published parameter sets

| Source | u | k | m | n | p | kh | kt | theta_c | dx | dt | Tag |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tzathas et al. 2024, Table 1 | 1e-3 m/yr | 2e-5 m^(1-2m)/yr | 0.4 | 1 | 1 m/yr | 0.1 m^2/yr | 1e-3 m/yr | tan = 0.57 | 50 / 25 / 12 m | see 3.7 | [V] |
| Jain, Benes, Cordonnier 2024, Table 1 | 1.2e-3 m/yr | 7e-4 | 0.4 | 1 | 1 m/yr | 0.04 m^2/yr | 5e-3 m/yr | 37 deg | 8 m | 10 to 300 yr stable | [V] |
| Schott 2023 `spe_shader.glsl` defaults | 0.03 * uplift map | 5e-4 | 0.8 | 2 | n/a | 200 (Laplacian mode) | debris `k_d = 10` (mode 2) | none | from heightfield | 50 (shader default, host overrides) | [V] code |
| Schott 2024 `erosion.glsl` defaults | none | 5e-4 | 0.8 | 2 | n/a | n/a | n/a | n/a | n/a | 1 | [V] code |

Other Tzathas constants: Hack's law `C = 1.5`, `h = 0.6`. [V] Jain also lists deposition `kd = 0.01` and debris-flow constants. [V]

Schott's units are not SI-consistent: the per-cell contribution to "drainage area" is `length(cellDiag)`, a length, not `dx^2`. [V] code. Do not mix Schott's `k` with a discharge in m^3/yr.

### 3.3 Drainage area / discharge on the GPU

**(a) Jacobi accumulation, one sweep per erosion step** (Schott 2023 [V] code; Jain 2024 [V])
```
A_i(new) = a0 + sum_{j in N(i)} w(j -> i) * A_j(old)        // a0 = p*dx^2  (Schott: |cellDiag|)
```
- Pure gather, ping-pong `A`, no atomics. Schott's shader does accumulation and erosion in one dispatch, reading `hf, stream` and writing `out_hf, out_stream`, then swaps. [V]
- A full accumulation from scratch needs as many sweeps as the longest river has cells, on the order of `sqrt(n)` for `n` cells. [V] FastFlow section 2
- Inside an erosion loop one sweep per time step is enough because the network changes slowly. [V] Jain: one iteration per time step does not significantly change the result.
- Failure cases: an existing terrain with depressions; noise added to uplift each step. With noisy uplift the approximate discharge is underestimated and the result depends on the noise amplitude (peak 3041 m to 4698 m in their test, against a stable 3024 to 3064 m with exact routing). [V] FastFlow Fig. 12

**Flow partition `w`**

| Scheme | Rule | Notes | Tag |
|---|---|---|---|
| Steepest descent (D8) | all flow to the neighbour with the largest slope | strongly axis-aligned erosion patterns | [V] Jain |
| MFD, slope^p | `w = S_i^p / sum S_k^p` over lower neighbours | Schott uses N8 with `p = 1.0` (2023) and `1.3` (2024) [V]; Freeman `p = 1.1`, Holmgren 4 to 6, Quinn 1 [V] https://richdem.readthedocs.io/en/latest/flow_metrics.html; tends to blur erosion [V] Jain | mixed |
| Random single receiver | pick one lower neighbour with probability proportional to the elevation drop | on average follows the steepest slope without axis alignment and without blur; used on N4 by Jain 2024, Tzathas 2024, FastFlow [V]; store the per-cell random number so the choice is stable between iterations [V] Tzathas | [V] |

Cost note [D]: Schott's MFD weight for neighbour `q` needs the slope sum over `q`'s own 8 neighbours, so one gather touches a 5x5 footprint. Either accept 25 height loads, or add a pre-pass that stores the per-cell slope sum (MFD) or receiver code (SFD) in one extra plane.

**(b) FastFlow, O(log n) parallel routing** (Jain, Kerbl, Gain, Finley, Cordonnier, Pacific Graphics 2024) [V] PDF read: https://people.cs.uct.ac.za/~Jgain/wp-content/papercite-data/pdf/jain2024.pdf
- Single-receiver trees on N4. Rake-and-compress: each sweep, a cell absorbs the discharge of donors that are leaves (and removes them), and bypasses donors that have exactly one donor. `log2(n)` sweeps.
- Needs a donor table (n x 4) built with atomic operations and care with read-after-write; their trick is a per-cell ping-pong flag.
- Flow routing under 55 ms up to 4096^2 on an RTX A6000; 5x faster than earlier GPU methods at 1024^2.
- Cannot do multiple flow directions.
- Code: https://gitlab.inria.fr/landscapes/fastflow (PyTorch, TensorFlow, CUDA kernels). Licence [U].
- Sweeps needed [D]: 20 at 1024^2, 24 at 4096^2, 26 at 8129^2.

**(c) Exact CPU routing** [S]/[D]
- Braun and Willett 2013: build the receiver/donor stack (topological order), accumulate upstream to downstream in O(n), then update heights in the reverse order. Described as the baseline by FastFlow, Jain, Tzathas [V mention].
- Suitable as a worker-thread fallback and as ground truth in tests.

### 3.4 Depression handling

Without it, water stops in every pit. FastFlow reproduces an escarpment test where valleys are carved much less deeply without depression routing, and Tzathas shows the same failure for GPU simulations eroding without uplift. [V] Orogen erodes arbitrary noise terrains, which are full of pits, so this is required, not optional. [D]

| Method | What it does | Complexity | GPU-friendly? | Tag |
|---|---|---|---|---|
| Priority-Flood (Barnes, Lehman, Mulla 2014) | seed a min-priority queue with edge cells; pop lowest, raise each unvisited neighbour to at least the popped level, push | O(n log n) float, O(n) integer | no (sequential) | [V] https://arxiv.org/abs/1511.04463 |
| Improved Priority-Flood | cells raised inside a depression go to a plain FIFO queue instead of the heap | O(m log m), m <= n, up to 37% faster | no | [V] same |
| Priority-Flood + epsilon | raised cells get `nextafter(level)` so every cell has a downhill neighbour; a fixed epsilon that is too large turns big depressions into mesas | same | no | [V] same |
| Priority-Flood + FlowDirs | leaves elevations untouched, each cell points to the cell that reached it, which drains depressions as if breached | same, no FIFO speed-up | no | [V] same |
| Planchon-Darboux 2001 | start with water surface `W` = +inf inside, `z` on the border; sweep `W = max(z, min_nb(W) + eps)` until nothing changes | iterative, many sweeps | yes as Jacobi | [S] MDPI 2019 variant description and SAGA docs |
| FastFlow depression routing | basins by pointer jumping; per basin the lowest saddle (lexicographic argmin with atomics); parallel Boruvka on the basin graph; then either "jumping" (pit points directly to outlet) or "carving" (reverse receivers along the path from saddle to pit) | `log2(L)` rounds of `log2(n)` sweeps, L = number of pits | yes with atomics | [V] FastFlow section 5 |
| Jain 2024 approximate | one refinement of basin labels and one Boruvka round per simulation step; basin detection on a Gaussian-smoothed terrain | amortised | yes | [V] |
| Lake sedimentation | below the water surface `w`, raise sediment by `(w - z) * min(1, S/W)` with `S` available sediment volume and `W` lake volume | local | yes | [V] Jain eq. 22 |
| Water-surface extraction on a routed tree | `w[c] = max(z[c], w[rcv(c)] + 2^(i-1) * eps)` with pointer jumping | `log2(n)` sweeps | yes | [V] FastFlow Alg. 6 |

**Recommended GPU scheme: warm-started Planchon-Darboux by Jacobi sweeps** [D]
```
w_new(c) = max( z(c), min_{nb} ( w(nb) + eps * dist ) )      // border cells: w = z
```
- The fixed point is unique and equals the filled surface. Convergence is fast only from above. From below, pits rise by `eps` per sweep, which is useless.
- Cold start: `w = max(z) + 1` in the interior. Sweeps needed are on the order of the longest drainage path in cells (a few times `N`).
- Warm start inside an erosion loop: `w0 = max(z, w_prev + delta)` where `delta` is the largest upward change of `z` since the last solve. This is guaranteed to be at or above the new solution. Then 2 to 8 sweeps per erosion step. A lowered outlet drains the lake by one cell per sweep.
- Route flow on `w` (which has an `eps` gradient across lakes toward the outlet). Lake mask: `w - z > threshold`.
- `eps` and `float32`: the spacing of `float32` is 2.4e-4 m between 2048 and 4096 m, 4.9e-4 m between 4096 and 8192 m. Use `eps >= 1e-3 m` per cell when heights are stored in metres. A 2000-cell lake then has 2 m of artificial tilt, acceptable for routing. For a flat rendered lake level run a second solve with `eps = 0`, warm-started from the first.

**Recommended CPU scheme for exactness** [D]: Priority-Flood + FlowDirs in a worker at a coarse pyramid level (512 to 1024), upload the receiver plane, let finer levels inherit the network.

### 3.5 Slope discretisation

- Slope to the lowest/steepest neighbour (Braun-Willett, Cordonnier 2016, Schott 2023) produces axis-aligned slopes. [V] Jain
- Rotation-invariant upwind gradient (Jain 2024 eq. 18) [V]; my reading of the typeset formula, check against the PDF:
  ```
  gx = max(0, z - z_E, z - z_W) / dx
  gy = max(0, z - z_N, z - z_S) / dx
  S  = sqrt(gx^2 + gy^2)
  ```

### 3.6 Time integration

**Explicit** (Schott [V] code)
```
spe   = k * noise * A^m * S^n
z_new = z - dt * (spe - kh * laplacian(z))           // mode 1
z_new = max(z_new, z_receiver)                       // never dig below the receiver
z_new = z_new + dt * uplift * upliftMap
```
- Schott fixes border cells to elevation 0 and uses one-sided Laplacians at edges. [V]
- Schott 2024 additionally clamps `S^n` to [0, 1] and caps the erosion term (`max_spe = 1e4` before multiplying by `k`). [V]
- CFL [D]: the SPL is an advection equation with celerity `n * k * A^m * S^(n-1)`, so `dt <= dx / (n * k * Amax^m * S^(n-1))`. For `n = 1`: `dt <= dx / (k * Qmax^m)`. Consistency checks: with Tzathas' constants on a 512 x 32 m grid this gives roughly 700 yr, and FastFlow reports 1000 yr as the upper stability limit of the explicit scheme at 512^2, dx = 32 m [V]. Same order.
- Hillslope diffusion adds `dt <= dx^2 / (4 * kh)` [D]. At `kh = 0.1 m^2/yr` this is 40 yr at dx = 4 m and 2.5 yr at dx = 1 m, so at fine resolution diffusion, not the SPL, limits the step.
- Way around the diffusion limit [V formulation]: Tzathas and FastFlow fold hillslope and thermal terms into the SPL coefficient, replacing `k*Q^m` with `k*Q^m + kt + kh * A^(-h)` (`h = 0.6`; Tzathas writes the last term as `(kh/C) * A^(-h)`). No Laplacian, no `dx^2` limit.

**Implicit, n = 1** (Braun-Willett form; FastFlow eq. 3-4 [V])
```
K      = k * A^m * dt / dist(i, rcv)
z_i    = ( z_i_old + u*dt + K * z_rcv_new ) / (1 + K)        // process outlets first, then upstream
```
- Derivation is mine [D]; FastFlow prints `z_t[c] = alpha * z_t[rcv] + beta` with `alpha = K/(1+K)` [V]. In the text I extracted from their PDF, `beta` reads as `z_old * (1+K)`; the algebra requires `z_old / (1+K)`. This may be a text-extraction artefact or a typo. Use the form above.
- Unconditionally stable. FastFlow: implicit dt = 20,000 yr gives a result visually similar to explicit 1,000 yr at 512^2, dx = 32 m; 10 Myr takes 0.5 s implicit against 7.2 s explicit. [V]
- GPU form (FastFlow Alg. 7 [V]): `log2(n)` pointer-jumping sweeps, each `z'[c] += alpha[c]*z'[rcv]; alpha[c] *= alpha[rcv]; rcv = rcv[rcv]`. Requires single receivers and `n = 1`.
- For `n != 1` use a per-node Newton iteration on `z - z_old - u*dt + K' * (z - z_rcv)^n = 0`. [S] Landlab docs describe the scheme; the formula here is [D].

**Analytical** (Tzathas et al., Eurographics 2024) [V] https://www-sop.inria.fr/reves/Basilic/2024/TGSC24/Analytical_Terrains_EG.pdf
- Time becomes a parameter of a closed-form solution evaluated along river trees; CPU (numpy + numba); needs a fixed-point iteration between network and elevations, accelerated with a multigrid-like coarse-to-fine scheme (4 to 5 levels, 5 to 6 iterations per level).
- Upsampling artefact and cure: plain bilinear upsampling makes rivers follow the coarse blocks; jitter the sample positions by a uniform offset in [-0.25, 0.25]^2 cells before interpolating.
- Code: https://gitlab.inria.fr/landscapes/analytical-terrains. Licence [U].

### 3.7 Deposition

- FastFlow semi-implicit: accumulate `Qs` from the previous step's elevation change with the same routing, then add `kd * Qs / Q`. Visually on par with the fully implicit scheme of Yuan et al. 2019, at the cost of some mass loss. [V]
- Jain 2024: explicit Euler for erosion and deposition together; `Qm` from the previous step; cap post-deposition height at the weighted mean of upstream neighbours. [V]
- Schott 2024 `deposition.glsl` (heuristic, not SPL-with-deposition) [V] code:
  ```
  stream  = rain*cellArea + MFD inflow            // rain = 2.6, flow exponent 1.3
  sed     = (pit ? sed : 0) + MFD sediment inflow
  cap     = stream^0.3 * clamp(slope^2, 0, 1)
  if (kdep*sed > cap): dep = min(sed, 0.1*(kdep*sed - cap)); z += dep; sed -= dep
  sed    += 0.1 * cap
  ```
  Recommended sequence per the README: erosion, then thermal, then deposition, alternated with 2x upsampling. [V]

### 3.8 Debris flow (optional, later) [V] Jain, Benes, Cordonnier, SIGGRAPH 2024, https://www.cs.purdue.edu/homes/bbenes/papers/Arymaan24ToG.pdf

- Adds a debris-flow erosion term that depends on slope and on upstream mobilised material, plus downstream deposition, solved with the same explicit routing machinery. Produces the steep, gullied upper slopes that SPL plus thermal renders as uniform ramps.
- 1024^2, 1600 iterations, 32 s on an RTX A6000 (0.02 s per iteration, PyTorch). [V]
- Code: https://gitlab.inria.fr/landscapes/debrisflow. Licence [U].

### 3.9 2024-2026 follow-ups found

| Work | Venue / date | Relevance | Tag |
|---|---|---|---|
| FastFlow | Pacific Graphics / CGF Oct 2024 | O(log n) GPU flow + depression routing, implicit SPL on GPU | [V] |
| Efficient Debris-flow Simulation for Steep Terrain Erosion | SIGGRAPH / TOG Jul 2024 | random receivers, upwind slope, approximate GPU depression routing | [V] |
| Physically-based Analytical Erosion | Eurographics / CGF Apr 2024 | analytical SPL, multigrid, parameter table | [V] |
| Terrain Amplification using Multi-scale Erosion | SIGGRAPH / TOG Jul 2024 | erode-upsample-erode pipeline, three small compute shaders | [V] code only |
| 3D Real-Time Hydraulic Erosion using Multi-Layered Heightmaps (Nilles et al.) | VMV 2024 | pipe model timings on RTX 3070; overhangs | [S] |
| Real-Time Desertscapes Simulation with CUDA (Nilles et al.) | GRAPP 2024, extended CCIS 2025 | deterministic GPU dunes | [V] |
| GraphFlood 1.0 (Gailleton et al.) | Earth Surface Dynamics Nov 2024 | stationary 2D hydrodynamics on a flow graph; CPU | [S] |
| Fast and Gorgeous Erosion Filter (R. S. Johansen) | blog, 30 Mar 2026 | simulation-free erosion-like noise | [V] |
| Gaea 2.2 Erosion2 | Jul 2025 [S] | commercial; deterministic, three sediment classes, orographic rain, parameters Duration / Downcutting / Erosion Scale | [V] https://docs.gaea.app/reference/nodes/simulate/erosion2.html; "runs entirely on GPU" is [S] |
| Houdini HeightField Erode rewrite | Houdini 21 | commercial; renamed parameters | [S] |

I found no 2025-2026 academic successor to FastFlow or Schott 2023 that adds multiple-flow-direction support to O(log n) routing. Absence of evidence only; searches were limited.

---

## 4. Particle / droplet erosion

### 4.1 Beyer 2015 as implemented by Sebastian Lague [V] code, https://github.com/SebLague/Hydraulic-Erosion (MIT)

Per droplet, up to `maxDropletLifetime` steps:
```
g        = bilinear gradient of height at pos;   h = bilinear height
dir      = normalize( dir*inertia - g*(1 - inertia) )
pos     += dir                                   // always one cell, regardless of speed
dh       = h(pos_new) - h(pos_old)
cap      = max( -dh * speed * water * sedimentCapacityFactor, minSedimentCapacity )
if sediment > cap or dh > 0:
    dep = (dh > 0) ? min(dh, sediment) : (sediment - cap) * depositSpeed
    deposit dep bilinearly on the 4 corners of the old cell
else:
    ero = min( (cap - sediment) * erodeSpeed, -dh )
    remove ero with a radial brush of weights (1 - dist/radius), normalised
speed    = sqrt( speed^2 + dh * gravity )
water   *= 1 - evaporateSpeed
```

| Parameter | Default |
|---|---|
| erosionRadius | 3 (range 2 to 8) |
| inertia | 0.05 |
| sedimentCapacityFactor | 4 |
| minSedimentCapacity | 0.01 |
| erodeSpeed | 0.3 |
| depositSpeed | 0.3 |
| evaporateSpeed | 0.01 |
| gravity | 4 |
| maxDropletLifetime | 30 |
| initialWaterVolume, initialSpeed | 1, 1 |

Demo image uses 70,000 droplets (map size there not confirmed; [U] that it is 255^2).

### 4.2 Nick McDonald, SimpleHydrology [V] code and blog, https://github.com/weigert/SimpleHydrology (MIT), https://nickmcd.me/2023/12/12/meandering-rivers-in-particle-based-hydraulic-erosion-simulations/

- Adds two persistent maps that particles write and read: discharge and momentum.
  ```
  // while descending
  discharge_track[cell] += volume
  momentum_track[cell]  += volume * speed
  // after all particles of a cycle
  map = (1 - lrate) * map + lrate * track        // lrate = 0.01 in the 2020 article
  // sampling
  discharge(p) = erf(0.4 * discharge_map(p))
  ```
- Particle dynamics:
  ```
  speed += gravity * normal.xz / volume
  speed += momentumTransfer * dot(norm(fspeed), norm(speed)) / (volume + discharge) * fspeed
  speed  = sqrt(2) * cell * norm(speed)                  // fixed step length
  c_eq   = max(0, (1 + entrainment * discharge) * (h_old - h_new))
  sediment += depositionRate * (c_eq - sediment);  height -= same
  volume  *= 1 - evapRate;  sediment /= 1 - evapRate
  ```
- Defaults: `maxAge 500, minVol 0.01, evapRate 0.001, depositionRate 0.1, entrainment 10, gravity 1, momentumTransfer 1`. [V] `water.h`
- The momentum feedback is what produces meanders; the 2023 demo is 960 x 960 for about 2000 cycles; the earlier flood-fill lake system was removed as slow and buggy. [V]

### 4.3 Is a GPU-parallel droplet solver worthwhile?

Evidence:
- Lague's own compute-shader version runs one whole droplet per thread (`numthreads(1024,1,1)`) and writes the shared height buffer with no synchronisation. Lost updates are simply tolerated. [V] `Erosion.compute`
- Galin's Heightfield library documents the same race in its GPU particle class, and says its race-free grid-based class gives results that are less good than the particle one. [V] https://perso.liris.cnrs.fr/eric.galin/Doc/Heightfield/class_g_p_u_hydraulic_erosion.html
- A CUDA implementation resolves conflicts with float atomic adds. [S] xarray-spatial docs. WGSL has no float atomics [U], so a WebGPU port needs fixed-point `atomic<i32>` deltas in a storage buffer, or accepts races.
- Races make the output non-deterministic, which breaks reproducible builds and golden-image tests.

Recommendation [D]:
- Do not build a GPU droplet solver for v1. Sections 1 and 3 cover the same visual range deterministically: the pipe model gives gullies, fans and lakes; the SPL gives dendritic valley networks at any scale.
- If the "droplet look" is wanted later, the least risky path is a deterministic CPU/WASM node run at a capped resolution (for example 2048^2) and upsampled, or a GPU version that accumulates fixed-point deltas with `atomic<i32>` into a storage buffer and applies them in a second pass (deterministic if each droplet reads only the previous batch's heights).
- Droplet counts scale with cell count and lifetimes with grid width, so cost grows like `N^3` for a fixed world extent. [D]

---

## 5. Derived maps

All are single-pass gathers unless noted. Height in metres, `dx` in metres.

| Map | Formula | Tag |
|---|---|---|
| Gradient | central differences `zx = (zE - zW)/(2dx)`, `zy = (zN - zS)/(2dx)`; or Horn 3x3 weights | [D] standard |
| Slope angle | `atan(sqrt(zx^2 + zy^2))` | [V] xDEM docs https://xdem.readthedocs.io/en/latest/terrain.html |
| Aspect | `atan2` of the gradient; fix the convention once (north = +y) | [D] |
| Second derivatives | `zxx = (zE - 2z + zW)/dx^2`, `zyy` likewise, `zxy = (zNE - zNW - zSE + zSW)/(4dx^2)` | [D] standard |
| Profile curvature | `-(zxx*zx^2 + 2*zxy*zx*zy + zyy*zy^2) / ((zx^2+zy^2) * (1+zx^2+zy^2)^1.5)` | [V] xDEM |
| Planform curvature | `-(zxx*zy^2 - 2*zxy*zx*zy + zyy*zx^2) / (zx^2+zy^2)^1.5` | [V] xDEM |
| Tangential curvature | same numerator as planform, denominator `(zx^2+zy^2) * sqrt(1+zx^2+zy^2)` | [V] xDEM |
| Flow accumulation | section 3.3; SFD for crisp lines, MFD for smooth wetness | see 3.3 |
| Topographic wetness index | `ln(a / tan(beta))`, `a` = specific catchment area = `A / dx` | [S] TauDEM / SAGA docs via search |
| Wear | cumulative positive erosion `E` (section 1.6) | [D]; Gaea exposes Wear, Deposits, Flow [V] https://docs.quadspinner.com/Reference/Erosion/Erosion.html |
| Deposition | `(b_final - b_initial) + E`, or the sediment layer thickness | [D] |
| Topographic position index | `z - mean of neighbourhood`; multi-scale with separable blurs | [V] definition, xDEM |
| Roughness | `max - min` of the 3x3 window | [V] xDEM |
| Sky-view factor / AO | `1 - (1/n) * sum_i sin(gamma_i)`, `gamma_i` = horizon elevation angle in azimuth `i` | [S] Zaksek et al. 2011 as restated by a citing paper |
| Distance field | jump flooding, section 5.2 | [S] |

Notes:
- Curvature is undefined where the gradient vanishes; guard `zx^2 + zy^2 < 1e-12`. Sign conventions differ between tools; fix one and document it. [V] the divergence, per SAGA/RichDEM docs
- TWI needs `tan(beta)` clamped away from 0. [D]
- Curvature from raw `float32` heights is noisy at fine `dx`; pre-blur by 1 to 2 cells or compute at a coarser pyramid level. [D]

### 5.1 Horizon-based AO and sun exposure [D]

```
for k in 0..D-1:                       // D = 8..16 azimuths, rotate per pixel with a hash
    maxTan = -inf
    for step t = 1..T:                 // T = 16..64, distance grows geometrically up to R
        q      = p + dir_k * r_t
        maxTan = max(maxTan, (z(q) - z(p)) / (r_t * dx))
    gamma_k = atan(max(maxTan, 0))
AO  = 1 - mean_k sin(gamma_k)          // sky-view factor form
sun = max(0, dot(normal, sunDir)) * (tan(sunElevation) > maxTan_in_sun_azimuth ? 1 : 0)
```
- Sample coarser mip levels of a max-height pyramid as the step grows to keep cost bounded.
- Sun exposure for snow and vegetation: average `sun` over 8 to 24 sun positions along the day arc.
- Published defaults for comparison: 16 directions with a 10-cell radius (xarray-spatial), 72 directions (topocalc). [S]

### 5.2 Jump flooding [S] Rong and Tan 2006; variants paper 2007; Wikipedia summary

- Each cell stores the coordinates of its nearest seed. Pass with step `k`: look at the 9 cells at offsets `{-k, 0, k}^2`, keep the closest seed. Steps `N/2, N/4, ..., 1`.
- `1+JFA` (an extra step-1 pass first) has a very low error rate at the cost of one pass.
- Passes [D]: 11 at 1024, 13 at 4096, 14 at 8129 (including the extra pass).
- Storage [D]: pack the seed as `x | (y << 16)` in `r32uint` (8129 < 65536); ping-pong two planes.

### 5.3 Ridge and valley detection [D]

- Valleys: threshold SFD drainage area. Ridges: the same on the negated heightfield.
- Cheaper local proxy: multi-scale TPI or the sign of planform curvature.
- Convert either to a distance field with JFA for masks such as "distance to ridge".

---

## 6. Snow, ice, coast, sand: simplest convincing GPU-friendly models

### 6.1 Snow [D], parameter names follow Gaea's Snow node [V] https://docs.gaea.app/reference/nodes/simulate/snow.html

State: snow depth `sn` over fixed terrain `b`.
```
accumulate:  sn += dt * intensity * smoothstep(snowLine - band, snowLine + band, b + sn) * adhesion(slope)
settle:      layered talus solver of 2.2 on (b + sn) moving only sn, tangent = tan(slipOffAngle)
melt:        sn -= dt * melt * sunExposure * max(0, T0 - lapse * (b + sn))
```
- Gaea exposes Duration, Intensity, Settle Duration, Melt (uniform or directional), Snow Line, Slip-off Angle, Adhered Snow Mass, Real Scale. [V]
- Default angles are heuristics: slip-off 35 to 45 degrees, lapse rate 6.5 K/km. [U]
- Iterations: accumulate and settle alternate; 50 to 200 settle sweeps at 1024. [D] estimate
- A research-grade alternative (stable / compacted / unstable / powder layers, avalanches) is Cordonnier et al. 2018. [S] abstract only

### 6.2 Glacier / ice flow: shallow ice approximation [V] `sia.glsl` in https://github.com/oargudo/glaciers (MIT), from Argudo et al. 2020

```
s      = b + h                                    // ice surface
D      = h^3 * ( fd * Gd * h^2 + fs * Gs ) * |grad s|^2      // deformation + sliding
h_new  = max(0, h + dt * ( mdot + div( D * grad s ) ))
mdot   = betaAccum  * (s - ELA) * kLocal    if s >= ELA
       = betaAblate * (s - ELA)             otherwise
```
- Constants in the shader: Glen exponent `n = 3`, `A = 7.57e-17`, `rho = 910`, `g = 9.81`, `Gamma = 2*A*(rho*g)^3/(n+2)`, active constants `Gamma_d = 7.26e-5`, `Gamma_s = 3.27`. [V]
- `A = 7.57e-17` equals the textbook 2.4e-24 Pa^-3 s^-1 expressed per year, so time is in years. [D] arithmetic
- Face diffusivities use a MUSCL reconstruction with a superbee limiter; the README credits Jarosch's mass-conserving SIA scheme. [V]
- The shader outputs the per-cell maximum `D` so the host can pick an adaptive `dt`. [V] Standard explicit bound: `dt <= dx^2 / (4 * Dmax)`. [D]
- Buffers are `double` in the original; WGSL has no `f64`, so test `f32` carefully (D scales as `h^5`). [D]
- Glacial erosion of bedrock (U-shaped valleys): erode at a rate proportional to a power of the sliding speed. [U] standard glaciology; the Cordonnier 2023 formulation was not read.
- Gaea's Glacier node is a surface generator fed by snow, not an ice-flow solver. [S]

### 6.3 Coast / sea erosion [D]

No canonical graphics paper was found. Commercial precedent: Gaea's Sea node exposes Level, Coastal Erosion, Shore Size, Shore Height, Variation, Extra Cliff Details [V] https://docs.gaea.app/reference/nodes/simulate/sea.html; TerraformFX uses a wave-height band [S].

Proposed model:
1. Sea mask: cells below sea level connected to the map edge. Iterative propagation on GPU (or reuse the fill of 3.4 with the sea level as the boundary value).
2. JFA from the shoreline: signed horizontal distance `r` to the coast.
3. Reshape inside `|r| < shoreSize`: blend towards a target profile `zt(r) = sea + shoreHeight * profile(r / shoreSize)` where `profile` is a gentle ramp seaward (wave-cut platform, beach) and leaves a scarp landward. Blend weight is modulated by noise ("variation") and by exposure (open fetch along a wave direction, computed like the horizon test in 5.1).
4. Run the talus solver for a few dozen sweeps so undercut cliffs relax.

Cost: 14 JFA passes plus 1 reshape pass plus thermal sweeps at 8129.

### 6.4 Aeolian sand and dunes

Lineage: Werner 1995 slab model [S]; Paris et al. 2019 "Desertscape Simulation" [V] code, https://github.com/aparis69/Desertscapes-Simulation (MIT); Nilles et al. 2024 deterministic GPU version [V], https://github.com/Clocktown/CUDA-Dune-Simulation (MIT).

**Paris 2019 reference code (CPU, stochastic)** [V] `desert-simulation.cpp`
- Pick a random cell; skip if no sand, if in wind shadow, or by vegetation probability.
- Lift a fixed slab; hop by the local wind vector; up to 3 bounces.
- Deposit with probability 0.6 on sand, 0.4 on bare bedrock (raised by vegetation); always in shadow.
- Local wind `= lerp(w, 2w, t)`, `t` from the alignment of wind with the sand gradient and from slope.
- Shadow: walk upwind up to 10 units; shadow strength from the steepest angle seen, ramped between a minimum and maximum angle.
- Reptation: on each bounce move a fraction of a slab to the two steepest downhill neighbours.
- Abrasion of bedrock where sand is thin; bedrock repose about 68 degrees.

**Nilles 2024 (GPU, deterministic)** [V] paper HTML
- Periodic grid, floats, cell width 0.25 to 2 m.
- Wind: `v = w_a * (1 + kW * h)` with `kW = 5e-3`; deflect along terrain contours using two Gaussian-smoothed gradients (sigma 50 and 200, weights 0.2 / 0.8, strengths 5 / 30); FFT convolution. The extended version makes the field divergence-free.
- Shadow: march upwind `10 m / l` cells with bilinear height samples; shadow ramps from 10 to 15 degrees.
- Saltation: replace random events by expectations. Lift `eps_s * (1 - shadow) * (1 - vegetation)` per step into a "slab" buffer, advect it by `w * dt / l` cells with a bilinear splat (4 float atomic adds), deposit a deterministic fraction, keep the rest airborne.
- Reptation: pairwise antisymmetric exchange proportional to slope and to the sand that just landed, gathered over 8 neighbours with no atomics.
- Avalanching: formula in 2.1; sand repose 33 degrees (45 with vegetation), bedrock 68 degrees.
- Timings on an RTX 4080, 1000 steps: 1.0 to 1.2 s at 1024 (dx 1 m), 5.9 to 7.4 s at 2048, 48 to 82 s at 4096. Avalanching is 35 to 85% of step time.

**WGSL adaptation** [D]
- Replace the forward bilinear splat (needs float atomics) with a backward semi-Lagrangian gather of the slab buffer, ping-ponged. Exactly conservative for uniform wind, nearly so for a divergence-free field.
- Skip the FFT: get the two smoothed gradients from two coarse mip levels of the heightfield.
- Avalanching: layered solver of 2.2.
- Planes: `bedrock, sand, sand', slab, slab', shadow, windU, windV, K` = 9.

---

## 7. Rivers and lakes

### 7.1 Extraction [D]

1. Fill (3.4) to get `w`; route single receivers on `w`; accumulate discharge `Q` exactly (CPU or FastFlow-style) because a thresholded map shows every error.
2. River cells: `A >= Ac`. `Ac` is the artistic "river density" control; expose it in km^2.
3. Width and depth from discharge, downstream hydraulic geometry: `width = kw * Q^0.5`, `depth = kd * Q^0.4`. Exponents 0.5 / 0.4 / 0.1 (width, depth, velocity) are the commonly cited Leopold and Maddock 1953 averages. [S]; the primary paper's abstract does not state them. Calibrate `kw`, `kd` so the largest river has a user-chosen width and depth.

### 7.2 Carving [D]

1. Bed elevation along the network must not rise downstream. Gather form: `bed(i) = max(bed(i), bed(rcv(i)))` iterated, or FastFlow Alg. 6 pointer jumping [V]. Start from `bed = w - depth(Q)`.
2. JFA from river cells, propagating the seed coordinates; each cell then knows its distance `r` to the nearest river cell and can look up that cell's `width`, `depth`, `bed`.
3. Cross-section:
   ```
   inside  (r <  width/2):  zc = bed + depth * (2r/width)^2            // parabolic channel
   bank    (r >= width/2):  zc = bed + depth + tan(bankAngle) * (r - width/2)
   z_new   = min(z, zc)                                                // carve only
   ```
   Optional floodplain: blend `z` towards `bed + depth` within a multiple of the width.
4. Outputs: river mask, water surface (`bed + depth` inside the channel), depth, flow direction (from receivers), plus lake mask and lake depth `w - z`.

Commercial precedent: Gaea's Rivers node has Water (headwater amount), Width, Depth, Downcutting, River Valley Width, Headwaters, and slightly modifies terrain so that paths are unbroken downslope. [V] https://docs.gaea.app/reference/nodes/simulate/rivers.html

### 7.3 Meanders

- Grid-routed rivers are jagged. Cheapest fix: domain-warp the lookup in step 2 with low-frequency noise scaled by `width`. [D]
- Emergent meanders from a momentum map (McDonald, 4.2). [V] CPU particles.
- Vector approach: trace the main channels into polylines on the CPU, apply curvature-driven migration with cutoffs (Paris et al., SIGGRAPH Asia 2023, code https://github.com/aparis69/Meandering-rivers, MIT [V] licence; method details not read [U]), then rasterise as a distance field on the GPU. Recommended for a later version.

### 7.4 Lakes

- Lake = connected region where `w - z > threshold` (3.4 with `eps = 0`).
- The pipe model also fills lakes physically if run long enough, but slowly.
- Lake sedimentation: Jain eq. 22 (3.4). [V]

---

## 8. Resolution independence and multi-resolution

### 8.1 What the sources say

| Observation | Source | Tag |
|---|---|---|
| Pipe model: time step halves when the grid doubles on a fixed domain | Mei Table 1 | [V] |
| SPL: time step must shrink in proportion to cell size, iterations grow 230, 460, 980 for dx = 50, 25, 12 m (implicit CPU simulation) | Tzathas section 7 | [V] |
| Analytical SPL with multigrid: one extra level per doubling, near-linear in cell count | Tzathas | [V] |
| Sand avalanching sweeps per step double with resolution | Nilles Table 2 | [V] |
| Gaea claims a 512^2 preview keeps parity for major erosion features with a 4K or 8K build, and exposes Feature Scale in metres (default 2000 m) plus Real Scale | Gaea 1.x Erosion node reference, https://docs.quadspinner.com/Reference/Erosion/Erosion.html | [V] claim; mechanism not documented |
| Houdini: quality of erosion features depends on heightfield resolution; "Erosion Feature Size" controls channel scale; chain several erode nodes | SideFX docs | [V] https://www.sidefx.com/docs/houdini/heightfields/erosion.html |
| World Machine: erosion is resolution dependent and chaotic; large soil movements can be done on a coarser grid and sharpened at full resolution | forum, founder comments | [S] |
| Schott 2024: alternate erosion / thermal / deposition with 2x upsampling | repo README | [V] |

### 8.2 Scaling rules for a fixed world extent [D]

| Quantity | Rule when `dx` changes |
|---|---|
| Pipe `dt` | `0.5 * sqrt(dx^3 / (2*A*g))`; with `A = dx^2` it scales as `sqrt(dx)` |
| Pipe iterations for the same water travel | proportional to `N` (about `2.8 * N` per domain crossing) |
| Rain, evaporation, `Ks`, `Kd` | invariant if written as rates multiplied by `dt` (Jako form) |
| Talus tangent, transfer fraction `c` | invariant |
| Thermal iterations | at least proportional to `N`; more for large features, so relax coarse levels first |
| SPL `k, m, n` | invariant if `A` is in m^2 (accumulate `p * dx^2`) and `S` is rise over run |
| SPL explicit `dt` | `dx / (k * Qmax^m)`; iterations for a fixed geological time proportional to `N` |
| Hillslope Laplacian | `dt <= dx^2 / (4*kh)`; avoid at fine levels with the `A^(-h)` form (3.6) |
| Droplets | count proportional to `N^2`, lifetime proportional to `N`, brush radius in metres |
| Noise | frequencies in cycles per metre; add octaves down to a wavelength of about `2*dx` |
| Epsilon for filling | absolute in metres, not per cell fraction |

### 8.3 Coarse-to-fine driver [D]

This is the single most important design choice for 4K to 8K output.

1. Express the simulation scale in world units: the user sets "feature scale" in metres; choose the base level so that scale spans a fixed number of cells (for example base `dx = featureScale / 32`). A 512^2 preview and an 8129^2 final build of the same terrain then run the large-feature stage at the same `dx`, which is how preview/final parity is obtained.
2. Run the simulation to near equilibrium at the base level (cheap).
3. Upsample 2x. Use jittered bilinear or bicubic sampling (offset in [-0.25, 0.25]^2 cells, per Tzathas [V]) and inject a small amount of band-limited noise at the new Nyquist band so finer channels can nucleate.
4. Run a reduced number of iterations at the new level: only features smaller than about two coarse cells need to develop, so the count per level is roughly constant in cells.
5. Repeat to the target resolution. Carry auxiliary state up too (discharge scaled by 1, sediment layers, water depth).
6. For non-power-of-two targets such as 8129 = 127*64 + 1, run levels at `(127*2^k + 1)`: 509, 1017, 2033, 4065, 8129. Resampling between these is exactly 2x on the vertex lattice. [D] arithmetic

Total cost is dominated by the finest level: `N^2 * iters_fine`, instead of `N^2 * c * N`.

---

## 9. Procedural primitives

### 9.1 Hash functions that behave identically across backends

Use integer hashes only. Trigonometric float hashes (`fract(sin(x) * 43758.5)`) depend on each driver's `sin` and will differ between Vulkan, D3D12 and Metal. [D]; that WGSL permits implementation-dependent accuracy for built-ins and allows reassociation/fusion is [S] (WebGPU CTS floating-point primer, luma.gl notes); `u32` arithmetic wrapping modulo 2^32 is [U] from memory of the WGSL spec.

Recommended by Jarzynski and Olano, "Hash Functions for GPU Rendering", JCGT 9(3), 2020 [V] https://www.jcgt.org/published/0009/03/02/paper.pdf: `pcg` for 1 to 1, `pcg3d` and `pcg4d` as the default multi-dimensional high-quality hashes.

```wgsl
// 1 -> 1, constants from the paper via Reed's write-up [V]
fn pcg(x: u32) -> u32 {
  let state = x * 747796405u + 2891336453u;
  let word  = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
// 3 -> 3, transliterated from the JCGT listing [V]
fn pcg3d(p: vec3<u32>) -> vec3<u32> {
  var v = p * 1664525u + 1013904223u;
  v.x += v.y * v.z;  v.y += v.z * v.x;  v.z += v.x * v.y;
  v = v ^ (v >> vec3<u32>(16u));
  v.x += v.y * v.z;  v.y += v.z * v.x;  v.z += v.x * v.y;
  return v;
}
// exact conversion to [0,1): 24 bits fit a float32 mantissa [D]
fn unit(x: u32) -> f32 { return f32(x >> 8u) * (1.0 / 16777216.0); }
```
- Feed lattice coordinates as `bitcast<u32>(vec3<i32>(ix, iy, seed))`. [D]
- Pick gradients from a small constant table indexed by hash bits (8, 12 or 16 directions) instead of `cos/sin` of a hashed angle. [D]
- Even then, float results are not guaranteed bit-identical across backends because multiply-add fusion may differ. Test with tolerances (for example 1e-5 relative), not bit equality. [D]

### 9.2 Gradient noise with analytical derivatives [V] https://iquilezles.org/articles/gradientnoise/

With cell `i = floor(p)`, `f = fract(p)`, corner gradients `ga..gd` and corner dot products `va = dot(ga, f)`, `vb = dot(gb, f - (1,0))`, `vc = dot(gc, f - (0,1))`, `vd = dot(gd, f - (1,1))`:
```
u     = f^3 * (f * (f*6 - 15) + 10)             // quintic
du    = 30 * f^2 * (f * (f - 2) + 1)
value = va + u.x*(vb - va) + u.y*(vc - va) + u.x*u.y*(va - vb - vc + vd)
grad  = ga + u.x*(gb - ga) + u.y*(gc - ga) + u.x*u.y*(ga - gb - gc + gd)
      + du * ( u.yx * (va - vb - vc + vd) + vec2(vb, vc) - va )
```
Use the quintic, not the cubic: the cubic leaves a visible second-derivative discontinuity once derivatives are used. [V] IQ, morenoise article

Value noise with derivatives (cheaper) [V] https://iquilezles.org/articles/morenoise/: `n = k0 + k1*u + k2*v + k4*u*v` in 2D, `dn/dx = (k1 + k4*v) * u'(x)`, `dn/dy = (k2 + k4*u) * v'(y)`.

### 9.3 fBm with derivatives and slope-damped fBm [V] IQ, morenoise

```
a = 0; b = 1; d = (0,0)
for i in 0..octaves:
    n  = noised(p)                    // (value, d/dx, d/dy)
    d += n.yz                         // raw per-octave derivatives, as in IQ's listing
    a += b * n.x / (1 + dot(d, d))    // damping: steep places get less fine detail
    b *= 0.5
    p  = M * p * 2.0                  // GLSL mat2(0.8, -0.6, 0.6, 0.8): rotation by 36.87 degrees
```
- IQ's terrain example uses 15 octaves, gain 0.5, lacunarity 2.0. [V]
- `d` above is a damping signal, not the gradient of `a`. [V]
- If the node must output a true analytical gradient of plain fBm `f(p) = sum b_i * n(P_i p)` with `P_i = (2M)^i`, accumulate `grad += b_i * transpose(P_i) * grad_n(P_i p)`. The derivative of a sum is the sum of derivatives, and the rotation and frequency must be applied to the gradient as well as to the coordinates. [V] principle stated by IQ; formula [D]

### 9.4 Ridged, billow, warping [U] unless tagged

- Billow: `abs(noise)*2 - 1` per octave.
- Ridged multifractal (Musgrave): `sig = offset - abs(noise); sig *= sig; sig *= weight; weight = clamp(sig * gain, 0, 1); sum += sig * freq^(-H)`. Usual defaults `offset = 1, gain = 2, H = 1, lacunarity = 2`. [U] from memory; an R package documents `offset = 1, gain = 2` [S].
- Domain warping: `f(p) = fbm(p + k * fbm(p + k * fbm(p)))` with `k` about 4. [U] from memory of IQ's warp article (the page did not load).

### 9.5 Worley / Voronoi

- F1, F2, F2 - F1 from a 3x3 search of jittered feature points.
- Exact distance to cell edges needs two passes: 3x3 to find the nearest point, then 5x5 around it taking `min dot(0.5*(mr + r), normalize(r - mr))`. F2 - F1 gives uneven line widths. [V] https://iquilezles.org/articles/voronoilines/

### 9.6 Directional "erosion-like" noise

| Version | Idea | Licence | Tag |
|---|---|---|---|
| Clay John, "Eroded Terrain Noise", Shadertoy `MtGcWh`, 2018 | stripes (gullies) aligned to the gradient of the running height, stripe frequency proportional to slope | not checked; Shadertoy's default for unlicensed shaders is reported as CC BY-NC-SA 3.0 | licence [U]; description [V] via Johansen's post |
| Fewes, "Terrain Erosion Noise", Shadertoy `7ljcRW`, 2023 | refinement and polish of the above; fades erosion at low altitude to hide valley bulges | not checked | licence [U] |
| R. S. Johansen, "Advanced Terrain Erosion Filter", Shadertoy `wXcfWn`, post dated 30 Mar 2026 | filter on top of any height function with a gradient; constant stripe width; fade towards a target in [-1, 1] (valley to peak); stacked fading mask; normalised and straightened gullies; ridge map output | MPL-2.0 (stated in the post) | [V] https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html |
| Phacelle noise (same author, Jan 2026) | the directional building block: one randomly placed pivot per grid cell, cosine/sine stripe pairs blended over a 4x4 cell neighbourhood (16 taps per octave), result normalised | not stated | [V] https://blog.runevision.com/2026/01/phacelle-cheap-directional-noise.html |
| `bevy_erosion_filter` | WGSL and Rust port of Johansen's filter | MPL-2.0 | [V] https://docs.rs/bevy_erosion_filter |

Per octave of the 2026 filter [V]: take the current slope direction, generate stripes along it with Phacelle noise, add `cos` as height and `sin` as slope contribution, fade by the mask, halve the stripe size (lacunarity 2), and let the next octave follow the slopes this one created. Example parameter values in the post: detail 0.7 / 1.5 / 3.0, normalisation factor 2, gully weight 0.5 with strength 2.0.

Licensing note (not legal advice): MPL-2.0 is file-level copyleft. Shipping it means keeping that shader file under MPL and publishing changes to it. Avoid deriving from the two older shaders until their licences are confirmed. The technique itself is described in prose in the 2026 post and can be reimplemented.

### 9.7 Other primitives worth having

- `psrdnoise`: tiling simplex noise with rotating gradients, GLSL plus a lightly tested WGSL port, MIT. [V] https://github.com/stegu/psrdnoise. Analytical derivatives [U].
- FastNoiseLite: OpenSimplex2, cellular, Perlin, value, domain warp; GLSL and HLSL ports, no WGSL; MIT. [V] https://github.com/Auburn/FastNoiseLite
- Crater [D]: with `r = dist / R`: bowl `-depth * (1 - r^2)` for `r < 1`, rim `rimH * exp(-(r-1)/rimW)`, ejecta falling off as a negative power of `r` (exponent about -3 [U]), central peak for large craters; combine with smooth min/max; scatter by Worley feature points with a size power law.
- Dune field [D]: ridged directional noise, `1 - abs(sin(dot(p, dir)*f + warp(p)))` shaped by an asymmetric profile (gentle windward, steep lee near 33 degrees), then a few talus sweeps. For real dune patterns use 6.4.

---

## 10. Open-source reference implementations

| Topic | Repository | Licence | What it is | Tag |
|---|---|---|---|---|
| Pipe model | https://github.com/bshishov/UnityTerrainErosionGPU | MIT | Unity compute shader, Mei-style pipeline; README documents the equations and calls out errors in Jako's paper | [V] |
| Pipe model | https://github.com/LanLou123/Webgl-Erosion | MIT | WebGL2; MacCormack sediment, velocity advection, permanent sources | [V] |
| Pipe model, multi-layer | Nilles et al. VMV 2024 (CUDA) | repo not found | timings only | [S] |
| Stream power, GPU | https://github.com/H-Schott/StreamPowerErosion | MIT | one GLSL compute shader, explicit SPL with Jacobi MFD accumulation | [V] |
| Stream power, WebGPU | https://github.com/GPU-Gang/WebGPU-Erosion-Simulation | BSD-3-Clause | WGSL port of Schott 2023; three ping-pong pairs; reports about 40 fps at 4.5k textures | [V] |
| Multi-scale erosion | https://github.com/H-Schott/MultiScaleErosion | MIT | `erosion.glsl`, `thermal.glsl`, `deposition.glsl` | [V] |
| O(log n) routing, implicit SPL | https://gitlab.inria.fr/landscapes/fastflow | unverified | PyTorch / TensorFlow / CUDA | URL [V], licence [U] |
| Debris flow + SPL | https://gitlab.inria.fr/landscapes/debrisflow | unverified | PyTorch | URL [V], licence [U] |
| Analytical SPL | https://gitlab.inria.fr/landscapes/analytical-terrains | unverified | Python, numba, Houdini file | URL [V], licence [U] |
| Landscape evolution library | https://github.com/fastscape-lem/fastscapelib | GPL-3.0 | C++/Python; do not copy code into a closed product | [V] |
| Depression filling, flow metrics | https://github.com/r-barnes/richdem | GPL-3.0 | Priority-Flood family, D8/D-inf, parallel variants; reference only | [V] |
| Thermal on GPU | Axel Paris blog code (`thermal-noracecondition.glsl`), repo `vincentriche/Outerrain` | not stated | racy and race-free versions | [V] content, licence [U] |
| Droplets | https://github.com/SebLague/Hydraulic-Erosion | MIT | C# plus a racy compute shader | [V] |
| Particles with discharge and momentum | https://github.com/weigert/SimpleHydrology | MIT | C++ | [V] |
| Layered particles, wind | https://github.com/weigert/SoilMachine | MIT | run-length encoded layers, water and wind particles | [V] |
| Simulation, GAN, river-network terrain | https://github.com/dandrino/terrain-erosion-3-ways | MIT | Python, 512^2 examples | [V] |
| Dunes, CPU | https://github.com/aparis69/Desertscapes-Simulation | MIT | Paris 2019 recode | [V] |
| Dunes, GPU | https://github.com/Clocktown/CUDA-Dune-Simulation | MIT | Nilles 2024, CUDA 12.5 | [V] |
| Glaciers | https://github.com/oargudo/glaciers | MIT | SIA compute shader | [V] |
| Meandering rivers | https://github.com/aparis69/Meandering-rivers | MIT | CPU, vector channels | [V] licence |
| Erosion-like noise | Shadertoy `wXcfWn`; https://docs.rs/bevy_erosion_filter; https://github.com/lpmitchell/AdvancedTerrainErosion | MPL-2.0 (first two); third unverified | 2026 erosion filter and ports | [V] / [U] |
| Noise | https://github.com/stegu/psrdnoise ; https://github.com/Auburn/FastNoiseLite | MIT ; MIT | | [V] |
| Hashes | JCGT paper listings | paper | `pcg`, `pcg3d`, `pcg4d` | [V] |

---

## 11. Recommended algorithm set and GPU pass structures

Iteration counts below are **estimates** [D] anchored on the verified data points quoted earlier (Jako: demos after 1000 iterations; Jain: 1600 iterations at 1024^2; Tzathas: 230 / 460 / 980; Nilles: sweeps proportional to N; my `2.8*N` wave-crossing figure). They must be calibrated by the testing agent before being hard-coded. "C2F" means the coarse-to-fine driver of 8.3.

### 11.1 Summary table

| # | Node | Algorithm | Planes (`r32float` unless noted) | Passes per iteration | Ping-pong | Iterations 1024^2 | Iterations 4096^2 |
|---|---|---|---|---|---|---|---|
| A | Fluvial erosion (large scale) | explicit SPL, Jacobi accumulation, random single receiver or MFD p = 1.3, upwind slope, receiver clamp, hillslope via `A^(-h)` term, uplift input | `z, z', Q, Q', uplift, erodibility, w, w'`, receiver (`r32uint`), optional `Qs, Qs', sediment` | 1 receiver pre-pass + 1 erode/accumulate pass + 2 to 8 fill sweeps | `z`, `Q`, `w` | 500 to 2000 | direct: 2000 to 8000; C2F: about 1500 at 1024, then 300 at 2048, 200 at 4096 |
| B | Hydraulic erosion (meso scale, deposits, lakes) | virtual pipes, Jako form, fixes of 1.5 | 13 (section 1.6) + erodibility + rain | 4 (+1 thermal) | `s`, `b` (thermal only) | 1000 to 3000 | direct: 4000 to 12000; C2F: 2000 at 1024, 800 at 2048, 400 at 4096 |
| C | Thermal / talus | pairwise gather (2.2), optional layer limiter | `b, b'`, talus/hardness, optional `K` | 1 (2 with limiter) | `b` | 100 to 300 | direct: 400 to 1200; C2F: about 100 per level |
| D | Fill depressions / lakes | warm-started Planchon-Darboux by Jacobi; CPU Priority-Flood for exact one-shot | `z, w, w'` | 1 per sweep | `w` | cold: 1500 to 3000 sweeps; C2F: about 100 per level | cold: 6000 to 12000; C2F: about 100 per level |
| E | Flow accumulation (output map) | SFD or MFD Jacobi; exact on CPU when it must be exact | `w, A, A'`, receiver | 1 per sweep | `A` | 1500 to 3000 | 6000 to 12000, or CPU |
| F | Derived maps | slope, curvatures, TPI, TWI: single pass each; AO / sun: 1 pass with `D*T` taps | input + output | 1 | none | 1 | 1 |
| G | Distance fields | 1+JFA | 2 x `r32uint` | 1 per step | yes | 11 passes | 13 passes |
| H | Rivers | D + E + G + bed monotone pass + carve | + `bed, width, depth` | see 7 | bed | about 50 bed sweeps or pointer jumping | about 200, or pointer jumping |
| I | Snow | accumulate + layered talus + melt | `b, sn, sn', K, sun` | 3 | `sn` | 50 to 200 | C2F |
| J | Dunes | Nilles-style, gather adaptation (6.4) | 9 | wind 1, shadow 1, saltation 2, reptation 1, avalanche 2 x sweeps | `sand`, `slab` | 500 to 2000 steps, 25 to 31 avalanche sweeps each | 100 to 125 avalanche sweeps per step [V]; prefer simulating at 1024 to 2048 and upsampling |
| K | Glacier | SIA explicit, adaptive `dt` | `b, h, h', ELA, beta, Dmax` | 1 (+ a max reduction for `dt`) | `h` | hundreds to thousands | run at 512 to 1024 and upsample; ice is smooth |
| L | Coast | sea mask + JFA + profile + talus | `z, mask, 2 x r32uint, z'` | see 6.3 | yes | 11 + 1 + about 30 | 13 + 1 + about 60 |
| M | Noise primitives | integer-hash gradient noise with derivatives, fBm variants, Worley, erosion filter | output only | 1 | none | 1 | 1 |
| - | Droplet erosion | not on GPU in v1 (4.3) | | | | | |

### 11.2 Node A in detail: stream power

```
per iteration:
  A0  receivers:   read w (N4 or N8), xi (hash) -> write rcv (r32uint: neighbour code, or 255 = none)
  A1  erode:       read z, Q, w, rcv, uplift, erod (3x3)
                   Q'  = p*dx^2 + sum_{j: rcv(j) == i} Q(j)
                   S   = upwind slope (3.5) on z
                   a   = k*erod*Q^m + kt + (kh/C)*A^(-h)
                   z'  = max( z - dt*a*S^n , z(rcv) ) + dt*uplift
                   write z', Q'                              (2 storage outputs)
  A2  fill x k:    w' = max(z', min_nb(w + eps*dist))        (k = 2..8, warm start per 3.4)
  swap z/z', Q/Q', w/w'
```
- `dt` from the CFL bound in 3.6 with a safety factor of 0.5; recompute when `Qmax` changes much.
- Lake cells (`w - z > threshold`): no erosion; if deposition is enabled, fill by Jain eq. 22.
- Workgroup 8x8.
- Start values: `Q = p*dx^2`, `w` from a cold fill at the coarsest level.

### 11.3 Node B in detail: virtual pipes

See 1.6. Per-iteration order: P1 flux, P2 water/velocity/capacity, P3 erosion-deposition, P4 advection, every k-th iteration P5 thermal. `dt = 0.5 * sqrt(dx^3 / (2*A*g))`. Start from Jako's Table 2 values and rescale rates to world units.

Memory at 8129^2 is about 3.3 GiB for the minimum plane set. It fits the 10 GB RTX 3080. It does not leave much room on the 6 GB GTX 1660 Ti once the rest of the graph holds textures; cap that machine at 4096^2 for this node or tile.

### 11.4 Node C in detail: thermal

One pass `b -> b'` with a 3x3 read, `c = 0.1`. With a mobile layer: T1 writes `K`, T2 gathers. Swap.

### 11.5 Shared infrastructure to build first [D]

1. Plane allocator with ping-pong pairs and in-place `read_write` support, and a fallback path when the language feature is missing.
2. Pyramid resampler with the `127*2^k + 1` ladder and jittered upsampling.
3. A CPU reference library (TypeScript or WASM, in a worker): Priority-Flood, exact D8/MFD accumulation in topological order, exact Euclidean distance transform. Used for tests and as a fallback for one-shot analysis maps.
4. Integer hash and noise library with tolerance-based golden tests across Dawn/Vulkan and D3D12.

---

## 12. Open questions

1. Iteration counts in 11.1 are estimates. They need calibration on real terrains at 1024 and 4096.
2. Does the warm-started Jacobi fill (3.4) keep up with erosion at 2 to 8 sweeps per step, or does drainage lag visibly? Not tested anywhere I could find.
3. Random single receiver against MFD p = 1.3 in an explicit Jacobi loop: which looks better at game scale (dx 1 to 4 m)? Papers show both; no shared benchmark.
4. Licences of the three Inria GitLab repositories and of the Clay John and Fewes shaders.
5. WGSL details taken from memory: `read_write` restricted to the three `r32` formats, no float atomics, `u32` wrap-around, out-of-bounds `textureLoad` behaviour.
6. `float32` adequacy for SIA (`h^5` terms) and for accumulated discharge at 8129^2 (up to 6.6e7 cells times `dx^2`; `float32` has 24 bits of integer precision, so summing unit contributions stalls at 1.7e7). Accumulate in units that keep the largest value below 2^24 times the smallest increment, or accumulate hierarchically.
7. Paper-level numbers for Schott 2023 and 2024 (convergence speed, timings) were not readable.
8. Glacial erosion law and coastal erosion have no verified simple reference model here; the proposals are designs.
9. Exponents and coefficients of hydraulic geometry should be checked against Leopold and Maddock 1953 before being presented as physical.
