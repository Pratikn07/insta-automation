# Guide cover font assets

TinySoho commits the exact font bytes used by the deterministic cover renderer.
Runtime rendering must use only the four allowlisted files below; it must not
download fonts or fall back to fonts installed on the host.

## Source Serif 4

- Source package: `@fontsource/source-serif-4@5.3.0`
- Upstream family: Source Serif 4
- License: SIL Open Font License 1.1
- License copy: `licenses/source-serif-4-OFL.txt`
- `source-serif-4-latin-400-normal.woff2` SHA-256:
  `02194deb92d3975dd30e11a3824a1f1db32b48c93654e60560cb81ce8e7b5f95`
- `source-serif-4-latin-600-normal.woff2` SHA-256:
  `f2b7e1cf1d277b7608231868135648f8ad8e2b58d8e97ca088bee15dc357bee7`

## Inter

- Source package: `@fontsource/inter@5.3.0`
- Upstream family: Inter
- License: SIL Open Font License 1.1
- License copy: `licenses/inter-OFL.txt`
- `inter-latin-400-normal.woff2` SHA-256:
  `8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc`
- `inter-latin-600-normal.woff2` SHA-256:
  `f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a`

The copied license texts are the unmodified `LICENSE` files from the exact npm
packages named above.
