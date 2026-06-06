# Third-Party Notices

This project ("birdgame") is built on top of several open-source components.
Their licenses are reproduced/credited below, as required.

---

## 1. Procedural Instanced Forest — MIT

Files:
- `src/vendor/RedReddingtonForest.js`
- `src/vendor/RedReddingtonForestNode.js`

Original author: **red-reddington** — https://codepen.io/the-red-reddington
Source: CodePen "Procedural Trees — Instanced High Performance" (JoXxmzY)
Thread: https://discourse.threejs.org/t/procedural-instanced-forest-high-performance-real-trees/88610

Ported to an ES module by Mathias Leonhardt (project: *birdybird*,
https://github.com/pmmathias/birdybird), reused here under the MIT License.
The original author granted permission and encouraged reuse. The MIT header at
the top of each file is preserved.

---

## 2. three.js — MIT

https://github.com/mrdoob/three.js — Copyright © 2010–2026 three.js authors.

---

## Deliberately NOT included

`birdybird` also ships an Ocean water renderer (`Ocean3.js` / `Ocean4.js`)
licensed **CC BY-NC-SA 3.0 (NonCommercial)**. Those files were **intentionally
excluded** from this project to avoid inheriting the non-commercial restriction.
If water is added later, use an MIT-licensed implementation instead.

---

The gameplay, multiplayer netcode (SpacetimeDB module + client integration),
bird models, world assembly, and UI in this repository are original work for
this project.
