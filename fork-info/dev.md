# Fork Development Notes

This fork carries FullCalendar-specific compressor options on top of upstream
Terser. The focused regression tests for those options live in:

```sh
test/mocha/fullcalendar-options.js
```

Run only those tests with:

```sh
pnpm run test:fullcalendar
```

## Why This Exists

Upstream Terser already has broad test commands:

```sh
pnpm run test:compress
pnpm run test:mocha
```

`test:compress` is still useful after changes to compression behavior. However,
`test:mocha` currently fails in this workspace before reaching the fork tests
because `test/mocha/cli.js` hits a Mocha/ESM loader cycle under the current
Node/Mocha setup.

The `test:fullcalendar` script gives this fork a stable, quick command for the
tests that directly cover the fork-only options:

- `compress.assume_mangled`
- `compress.number_inline_aggressiveness`
- `compress.string_inline_aggressiveness`
- `compress.string_inline_lte_length`

Use it during iteration whenever those options, sizing logic, or inline
threshold behavior changes. It checks the important fork contracts: default
settings are byte-identical to stock behavior, `assume_mangled` only changes
size estimation for mangleable names, globals stay unshortened, and literal
inline controls only affect their matching constant types.

Before handing off larger changes, also run:

```sh
pnpm run lint
pnpm run build
pnpm run test:compress
```
