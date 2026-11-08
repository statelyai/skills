# Render a checked chart

Native Checks is the interactive review surface. For every `.mmd` chart shown,
also provide its Mermaid text and a portable SVG through the owned command:

```sh
sh SKILL_DIR/scripts/stately-check render RUN_DIR/chart.mmd
sh SKILL_DIR/scripts/stately-check render RUN_DIR/chart.mmd --out NEW_CHART.svg --offline
```

On Windows, use the native launcher with the same arguments:

```powershell
& 'SKILL_DIR/scripts/stately-check.ps1' render RUN_DIR/chart.mmd
```

The default SVG sits beside the `.mmd` with the same basename. Existing output
files are preserved; choose a new `--out` to render again. The helper lazily
fetches a SHA-pinned standalone Pele 1.9.0 module into the external Stately
cache, using HTTPS/checksum validation. No npm install, mise, repository
`node_modules`, or user setup command is needed. `--offline` requires that
renderer to be cached; `STATELY_CACHE_DIR` selects the cache.

Rendering uses `{ limit: 1_000_000, outputLimit: 8_000_000, maxEdges: 10_000 }`,
large enough for the checker diagram budget. If rendering fails, preserve and
show the Mermaid text plus the actual error. A rendering error changes no TLC
verdict. Do not substitute a different renderer unless the user requests it.
With no `chart.mmd`, show the rule summary/report rather than inventing a chart.

The CSS below is the shared light/dark styling applied by the owned helper.
It preserves group colors, definite/possible breaks, shortest bug paths, and
repeating temporal paths. It is an installed reference, independent of the
excluded engine test directory.

Adapted from Lauren Tan's `statechart` rendering guide, copyright (c) 2026 Lauren
Tan, MIT licensed. [License](../scripts/engine/LICENSE.md); [pinned upstream
source](https://github.com/cursor/plugins/tree/ae5650febf4320793844c12c4adaa937f417f8da/pstack/skills/statechart).
The original package API/theming references are https://pele.run/api and
https://pele.run/theming. Stately owns the launcher, cache, and renderer adapter.

## Colors

Pele ignores Mermaid `theme` and `themeVariables`. Set its `--pele-*` CSS variables on `.pele`. https://pele.run/theming lists them. The command gives each state the color class of its group, such as `class sN teal`. It marks each bad state with `class sN breaks` or `class sN mayBreak`, each state on the shortest path to a bug with `class sN bugPath`, and each state that a PROPERTY counterexample repeats forever with `class sN repeats`. Pele puts these classes on the state's node. Color the classes with CSS.

The `.mmd` file has a `classDef` line for `breaks` and for `mayBreak`, so that any Mermaid viewer shows the bug marks. It has no `classDef` for the group colors, `bugPath`, or `repeats`. Pele writes each `classDef` color as a `style` attribute on the node, and a `style` attribute wins over a normal CSS rule. So the rules for the marks below use `!important`. Without it, a dark theme keeps the light mark colors. A bug mark sets the fill and the text, and `bugPath` and `repeats` set the border. Put the mark rules after the group colors, so that a mark shows over the group color.

The helper embeds these shared colors in a `<style>` element in each SVG so it follows the viewer's light/dark setting. Preserve the mark overrides and ordering when adapting presentation.

```css
.pele {
  --pele-bg: #ffffff;
  --pele-fg: #1c1c1c;
  --pele-muted: #656565;
  --pele-line: #808080;
  --pele-surface: #fcfcfc;
  --pele-surface-alt: #f1f1f1;
  --pele-border: #c9c9c9;
}
.pele .blue rect {
  fill: #c3e0ff;
}
.pele .orange rect {
  fill: #f0d3bf;
}
.pele .purple rect {
  fill: #e3d5ff;
}
.pele .yellow rect {
  fill: #f0dcbf;
}
.pele .teal rect {
  fill: #bfe3df;
}
.pele .tan rect {
  fill: #e5d9ce;
}
.pele .pink rect {
  fill: #ffcbe6;
}
.pele .breaks rect {
  fill: #ffecee !important;
  stroke: #e72e3b !important;
  stroke-width: 2.5px !important;
}
.pele .breaks text {
  fill: #cd2834 !important;
}
.pele .mayBreak rect {
  fill: #fff3e6 !important;
  stroke: #e8730c !important;
  stroke-width: 2.5px !important;
}
.pele .mayBreak text {
  fill: #b85a06 !important;
}
.pele .bugPath rect {
  stroke: #1680f3 !important;
  stroke-width: 2.5px !important;
}
.pele .repeats rect {
  stroke: #9b35d6 !important;
  stroke-width: 2.5px !important;
  stroke-dasharray: 6 3;
}
@media (prefers-color-scheme: dark) {
  .pele {
    --pele-bg: #1f1f1f;
    --pele-fg: #f5f5f5;
    --pele-muted: #acacac;
    --pele-line: #939393;
    --pele-surface: #121212;
    --pele-surface-alt: #2c2c2c;
    --pele-border: #4e4e4e;
  }
  .pele .blue rect {
    fill: #1b3857;
  }
  .pele .orange rect {
    fill: #573117;
  }
  .pele .purple rect {
    fill: #3c2e57;
  }
  .pele .yellow rect {
    fill: #573d17;
  }
  .pele .teal rect {
    fill: #174641;
  }
  .pele .tan rect {
    fill: #3d3127;
  }
  .pele .pink rect {
    fill: #57233e;
  }
  .pele .breaks rect {
    fill: #2e2021 !important;
    stroke: #cf2b35 !important;
  }
  .pele .breaks text {
    fill: #ff6463 !important;
  }
  .pele .mayBreak rect {
    fill: #2e2619 !important;
    stroke: #d0700f !important;
  }
  .pele .mayBreak text {
    fill: #ffa257 !important;
  }
  .pele .bugPath rect {
    stroke: #116dd2 !important;
  }
  .pele .repeats rect {
    stroke: #9a3fcf !important;
  }
}
```
