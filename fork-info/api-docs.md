# Extra Terser Compress Options

This build of Terser adds three non-standard options to the `compress` object,
on top of everything in upstream Terser. All three are **off by default** (their
defaults are exact no-ops), so existing configs behave unchanged until you opt
in.

```js
import { minify } from "terser";

await minify(code, {
  compress: {
    assume_mangled: true,             // size identifiers as if a mangle pass will run
    string_inline_aggressiveness: 2,  // lean into gzip-friendly string inlining
    string_inline_lte_length: 9,      // force-inline strings up to this length
  },
  mangle: false,
});
```

## Quick reference

| Option | Type | Default | Summary |
|---|---|---|---|
| `assume_mangled` | boolean | `false` | When compressing **without** mangling, make size-based decisions as if names will be mangled later. |
| `string_inline_aggressiveness` | number | `1` | Bias toward (or away from) inlining repeated **string** constants. `> 1` inlines more. |
| `string_inline_lte_length` | number | `-1` | Force-inline repeated **string** constants whose value length is at most this number. |

---

## `assume_mangled`

**Type:** `boolean` · **Default:** `false`

Terser makes several compression decisions by comparing byte sizes — most
notably, whether to inline a constant into its use sites or keep it as a shared
variable. Those size estimates normally treat each identifier as costing its
**full source name length** unless mangling is turned on, in which case names
are treated as ~1 character.

That's a problem if you compress in one step and mangle in a **separate, later
step** (for example, shipping readable library output that a downstream bundler
will mangle in its own context). With mangling off, Terser over-estimates the
cost of keeping a named variable and can make choices it never would in a
mangled build — such as duplicating a constant across many sites because it
thinks the variable name is "expensive," even though that name will be one
character after the downstream mangle.

Setting `assume_mangled: true` makes Terser size identifiers **as if a mangle
pass will run**, so a compress-only pass produces the same size-driven decisions
you'd get end-to-end.

```js
await minify(code, {
  compress: { assume_mangled: true },
  mangle: false,            // names preserved for a later pass
});
```

**Behavior notes**

- **No-op when mangling is on.** If `mangle` is enabled, Terser already sizes
  names as mangled, so this option does nothing.
- **It only affects size estimation, never the output names.** Your identifiers
  are still emitted verbatim; nothing is renamed.
- **It respects un-manglable names.** Globals and built-ins (`BigInt`, `Math`,
  `window`, …), exported names, methods, and names protected by `keep_fnames` /
  `keep_classnames` keep their real length — exactly as a real mangler would
  leave them alone. It is not a blunt "treat every identifier as 1 char."
- **It mirrors your mangle-related compress settings.** The assumption is built
  from your `toplevel`, `module`, `keep_fnames`, and `keep_classnames` values.
  If your downstream mangle runs in module mode or mangles top-level names, set
  `module` / `toplevel` accordingly so the estimate matches what that pass will
  actually do.

**When to use it:** any compress-without-mangle pass whose output will later be
mangled. If you compress and mangle in the same Terser call, you don't need it.

---

## `string_inline_aggressiveness`

**Type:** `number` · **Default:** `1`

Controls how eagerly Terser inlines a **string constant that is used in several
places**, versus keeping it as one shared variable.

Terser's size model counts raw bytes and is blind to gzip/brotli. But
compressors deduplicate repeated strings extremely well — several copies of a
string cost roughly one copy plus a few cheap back-references. As a result,
inlining a small repeated string is often **smaller after gzip** than keeping a
shared constant, even though it looks larger before compression. Terser's
default cost model can't see that and tends to keep such strings as shared
consts.

This option lets you bias that decision:

- `> 1` — treat repeated strings as cheaper to inline ⇒ **more** inlining
  (the gzip-favorable direction). `2` is a reasonable starting point.
- `1` — stock Terser behavior (default).
- `< 1` — inline repeated strings **less**.

```js
await minify(code, {
  compress: { string_inline_aggressiveness: 2 },
});
```

**Behavior notes**

- **Strings only.** Numeric constants, functions, single-use values, and `this`
  aliases are unaffected — only string constants used more than once are
  influenced.
- **It only shifts the threshold.** Larger strings stay shared (their cost is
  high regardless), so raising the value mainly flips the *small* repeated
  strings — which is where the gzip benefit is largest.
- **It trades pre-gzip size for post-gzip size.** This is only a win when the
  files you ship are gzip- or brotli-compressed. If you serve these assets
  **uncompressed**, a value above `1` will make them larger.

**When to use it:** when you measure your bundle **after** gzip/brotli and want
to reclaim the size Terser leaves on the table by keeping small repeated strings
as variables. Always compare the **compressed** artifact when tuning — the
uncompressed size will go up, the compressed size is what should go down. Sweep
a few values (e.g. `1.5`, `2`, `3`) against your real bundle and keep whatever
minimizes the gzipped output.

---

## `string_inline_lte_length`

**Type:** `number` · **Default:** `-1`

Forces Terser to inline a repeated **string** constant when the string value's
length is less than or equal to the configured threshold, bypassing the normal
size comparison.

```js
await minify(code, {
  compress: { string_inline_lte_length: 9 },
});
```

This option is checked before `string_inline_aggressiveness`. If the string
meets the threshold, it is inlined immediately. If it does not meet the
threshold, Terser falls back to the usual size gate, including any
`string_inline_aggressiveness` bias.

**Behavior notes**

- **Strings only.** Numeric constants, functions, single-use values, and `this`
  aliases are unaffected.
- **The length is the JavaScript string value length.** It does not include
  surrounding quotes or extra bytes needed to escape the string when printed.
- **The default is an exact no-op.** `-1` means no string can pass the
  threshold unless you opt in.
- **This can grow pre-gzip output quickly.** It intentionally ignores how many
  times the string will be duplicated, so tune it against real gzip/brotli
  output.

**When to use it:** when measurement shows that strings at or below a known
length should always be duplicated for better compressed size, even when
Terser's raw byte model says to keep the shared binding.

---

## Using them together

The string options run in a fixed order: `string_inline_lte_length` can
force-inline a string first; otherwise `string_inline_aggressiveness` adjusts
the normal size threshold. They can be combined with `assume_mangled` in a
compress-only first pass:

```js
await minify(librarySource, {
  compress: {
    assume_mangled: true,
    string_inline_aggressiveness: 2,
    string_inline_lte_length: 9,
  },
  mangle: false,   // a downstream tool mangles later
});
```

`assume_mangled` keeps the compress-pass decisions consistent with the eventual
mangled output; the string options add deliberate, gzip-aware pressure toward
inlining repeated strings. None of these options rename anything, so the pass-1
output stays readable for whatever runs next.

> These options are specific to this Terser build and are **not** part of
> upstream Terser. If you replace this build with stock Terser, remove them from
> your config.
