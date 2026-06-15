# Terser Mod Plan: `assume_mangled` & `inline_string_aggressiveness`

> **For the implementing agent (Claude Code / Codex):** This adds two new
> `compress` options to **terser 5.48.0**. Apply as a minimal patch via
> `patch-package` against `node_modules/terser` (preferred) or a thin fork.
> Both options default to a **no-op**, so with neither set the output must be
> byte-identical to stock terser — treat that as a regression guard. Do **not**
> refactor terser's ambient-`mangle_options` pattern or thread new params through
> `walk_parent`; keep the diff confined to the exact spots below. Match terser's
> snake_case option naming.

---

## 1. Background / why these exist

The build pipeline runs terser in **two passes**: pass 1 compresses with
`mangle: false` (identifiers preserved so the downstream consumer can mangle in
their own context); pass 2 is the consumer's own `compress + mangle`. Two
problems with pass 1 motivate this mod:

1. **Identifier sizing is wrong when mangling is off.** terser's cost model sizes
   a symbol at its real `name.length` unless mangling is active, so in a
   mangle-off pass it over-prices keeping a named binding and makes
   size-gated decisions (notably constant inlining) as if long names will
   survive — when in reality the downstream pass will shorten them to ~1 char.
   `assume_mangled` makes pass-1 sizing behave as if a mangle pass will run.

2. **The cost model is gzip-blind for repeated strings.** terser charges an
   inlined string as `N × literal_bytes`, ignoring that gzip's LZ77 dedups
   repeats (≈ one copy + cheap back-references). It therefore keeps small
   repeated strings as shared consts when inlining them would be *smaller after
   gzip*. `inline_string_aggressiveness` biases that specific decision toward
   inlining.

### Internals the changes rely on (terser 5.48.0)

- **`AST_Node.prototype.size(compressor)`** (`lib/size.js` ~line 92) is the
  aggregator: it walks a subtree and sums each node's `_size`. It seeds a
  **module-level `mangle_options`** from `compressor._mangle_options` at the top
  and clears it at the bottom. Per-node `_size` methods (e.g.
  `AST_Symbol.prototype._size`, line 441) read that ambient variable — they
  receive no compressor.
- **`AST_Symbol.prototype._size`** returns `1` only when
  `mangle_options && this.thedef && !this.thedef.unmangleable(mangle_options)`,
  else `this.name.length`. `unmangleable` (`lib/scope.js` ~155) correctly flags
  globals/undeclared (`BigInt`, `Math`, …), exports, methods, and
  keep_fnames/keep_classnames-protected names as un-shrinkable.
  `format_mangler_options` (`lib/scope.js:785`) folds `module → toplevel`
  (line 796), which is why `unmangleable` only needs to read `toplevel`.
- **`inline_into_symbolref`** (`lib/compress/inline.js` ~169) has two branches:
  - **single-use** (≈191–278): inlines unconditionally, **no size check**.
  - **multiple-use** (≈280–316): only sets `replace` when `fixed.evaluate()`
    yields a **constant** (or the narrow `AST_This` alias). The size inequality
    `replace_size <= name_length + overhead` lives here, at ~312. This is the
    *only* place identifier/value size gates an inlining decision, and it is
    structurally limited to **constant values referenced ≥ 2 times**. Functions
    never produce a `replace` here, so "consts not functions" is automatic.

The inline decision is one inequality — `value_size ≤ name_size + overhead`.
**Feature 1 tunes the right side** (`name_size` → its mangled value).
**Feature 2 tunes the left side** (`value_size` for strings). They are
orthogonal and compose without interaction.

---

## 2. Feature 1 — `compress.assume_mangled`

**Type:** boolean. **Default:** `false`. **Effect:** when set *and* real
mangling is off, size identifiers as if a mangle pass will run (mangleable
locals → 1 char; globals/exports/methods/kept names keep real length). No-op
when mangling is already on (those symbols already size to 1).

**Scope of effect:** every compressor-aware `.size()` consumer — so it influences
both value/constant inlining *and* `evaluate`'s string-fold cost check. It does
**not** affect the `best_of` family (those call `.size()` with no compressor and
stay mangle-blind by design).

### Changes

**(a) `lib/compress/index.js` — add the option default** inside the
`this.options = defaults(options, { … })` block (begins at line 224, alongside
`keep_fnames`, `reduce_vars`, `unused`):

```js
assume_mangled: false,
```

**(b) `lib/compress/index.js` — precompute the synthetic options** in the
`Compressor` constructor, immediately after `this._mangle_options = …`
(lines 333–335). `format_mangler_options` is already imported (line 168), and
`this.options` is already set (line 224), so `this.option(...)` is safe here:

```js
this._assume_mangled_options =
    !this._mangle_options && this.option("assume_mangled")
        ? format_mangler_options({
              toplevel:        this.option("toplevel"),
              module:          this.option("module"),
              keep_fnames:     this.option("keep_fnames"),
              keep_classnames: this.option("keep_classnames"),
          })
        : undefined;
```

> The `!this._mangle_options` guard encodes "no-op when actually mangling".
> Deriving the four fields from the compress-option counterparts is
> shortcut-safe (the top-level `toplevel`/`module`/`keep_*` shortcuts are already
> resolved into the compress options before the `Compressor` is constructed).
> `format_mangler_options` folds `module → toplevel` and defaults the rest, so
> the object is shaped identically to a real `_mangle_options`.

**(c) `lib/size.js` — read the new field** in `AST_Node.prototype.size`
(~line 92–94). Change:

```js
mangle_options = compressor && compressor._mangle_options;
```

to:

```js
mangle_options =
    (compressor && compressor._mangle_options) ||
    (compressor && compressor._assume_mangled_options);
```

Leave the existing `mangle_options = undefined;` reset at the bottom in place.

> **Do not modify `AST_Symbol.prototype._size`.** Feeding it a synthetic
> `mangle_options` makes its existing logic do exactly the right thing —
> `unmangleable` keeps globals/exports/etc. at real length for free. Keeping the
> synthetic options on the dedicated `_assume_mangled_options` field (not on
> `_mangle_options`) is deliberate: `_mangle_options` is also read by
> `compressor.mangle_options()` and name-generation paths, and we must not let
> `assume_mangled` leak into actual mangle-ish behavior.

---

## 3. Feature 2 — `compress.inline_string_aggressiveness`

**Type:** number (multiplier). **Default:** `1` (exact no-op). **Effect:**
discounts the apparent size of a **string** constant when deciding whether to
inline it into its multiple use sites. `> 1` ⇒ treat repeated strings as cheaper
⇒ **more** inlining (the intended direction for the gzip win); `< 1` ⇒ less.
Applied as a **divisor** on `replace_size` so it scales the *value* only, never
the identifier.

**Scope of effect:** only the multiple-use constant branch of
`inline_into_symbolref`, and only when the replacement is an `AST_String`.
Single-use inlining (no size gate), numeric constants, and the `AST_This` alias
path are all untouched. Because the decision sits at the margin, a `> 1` factor
flips small repeated strings (near the threshold) while leaving large strings
(far above it) as shared consts — matching the observed gzip behavior.

### Changes

**(a) `lib/compress/index.js` — add the option default** in the same
`defaults(...)` block as Feature 1:

```js
inline_string_aggressiveness: 1,
```

**(b) `lib/compress/inline.js` — import `AST_String`.** It is **not** currently
imported. Add `AST_String,` to the AST import block from `"../ast.js"` (the block
ending at line 87, where `AST_Class`, `AST_Lambda`, etc. are imported).

**(c) `lib/compress/inline.js` — apply the discount** in `inline_into_symbolref`,
multiple-use branch (the `if (replace) { … }` at ~301–314). Change `replace_size`
from `const` to `let` and divide it for string replacements:

```js
if (replace) {
    const name_length = self.size(compressor);
    let replace_size = replace.size(compressor);

    const string_scale = compressor.option("inline_string_aggressiveness");
    if (string_scale !== 1 && replace instanceof AST_String) {
        replace_size = replace_size / string_scale;
    }

    let overhead = 0;
    if (compressor.option("unused") && !compressor.exposed(def)) {
        overhead =
            (name_length + 2 + fixed.size(compressor)) /
            (def.references.length - def.assignments);
    }

    if (replace_size <= name_length + overhead) {
        return replace;
    }
}
```

> Leave `overhead` untouched — it mixes `name_length` and `fixed.size`, and we
> must not scale the identifier. Only `replace_size` (the value) is discounted.
> Guarding on `string_scale !== 1` preserves the exact no-op default.
>
> **Optional follow-up (not v1):** if a uniform multiplier starts pulling in
> medium strings that shouldn't inline, switch to an *additive* discount
> (`replace_size - k`, floored at ~2). Gzip's per-repeat saving is roughly
> length-independent, so a fixed subtraction favors short strings
> disproportionately. Keep this in reserve; ship the multiplier first.

---

## 4. File-by-file change summary

| File | Location | Change |
|---|---|---|
| `lib/compress/index.js` | `defaults({…})` block, ~line 224 | Add `assume_mangled: false,` and `inline_string_aggressiveness: 1,` |
| `lib/compress/index.js` | after `this._mangle_options = …`, ~line 335 | Add `this._assume_mangled_options = …` precompute |
| `lib/size.js` | `AST_Node.prototype.size`, ~line 94 | OR in `compressor._assume_mangled_options` when setting `mangle_options` |
| `lib/compress/inline.js` | AST import block, ~line 87 | Add `AST_String` to imports |
| `lib/compress/inline.js` | `inline_into_symbolref` multi-use branch, ~line 301–314 | `let replace_size`; divide by `inline_string_aggressiveness` for `AST_String` |

No other files. `AST_Symbol.prototype._size` and `_mangle_options` semantics are
**unchanged**.

---

## 5. Testing / definition of done

Use a Node harness (`terser` + `zlib`) mirroring these checks.

### Regression guard (must pass first)
With neither option set (or `assume_mangled:false`, `inline_string_aggressiveness:1`),
output is **byte-identical** to stock terser across a sample corpus.

### Feature 1
```js
const code = `function f(){
  var someLongLocalNameThatIsExpensiveToKeepRepeating = "aLongishStringConstant";
  return [someLongLocalNameThatIsExpensiveToKeepRepeating,
          someLongLocalNameThatIsExpensiveToKeepRepeating,
          someLongLocalNameThatIsExpensiveToKeepRepeating];
}
window.f = f;`;
```
- `minify(code, { compress:{}, mangle:false })` → **inlines** the literal 3× (the bug).
- `minify(code, { compress:{ assume_mangled:true }, mangle:false })` → **keeps** the
  shared `var` (names still un-mangled). ✅ pass-1 sizing now matches the mangled world.
- `minify(code, { compress:{}, mangle:true })` → keeps the shared binding (mangled).
- **Assert:** the `assume_mangled` run makes the same keep-vs-inline decision as the
  `mangle:true` run.
- **Global guard:** a snippet using `BigInt(x)*BigInt(y)` etc. must not change its
  decisions under `assume_mangled` purely because a global name was "shortened"
  (globals are `undeclared` ⇒ `unmangleable` ⇒ still real length).

### Feature 2
```js
const code = `function f(a){
  const s = "ab";            // small, repeated
  return a ? s : (a+s+s+s);  // several uses
}
window.f = f;`;
```
- Compare `inline_string_aggressiveness: 1` vs `> 1` (e.g. `1.5`, `3`): the higher
  value should inline the string where the default keeps the `const`.
- gzip (`zlib.gzipSync`) both outputs and **assert the inlined variant is smaller
  post-gzip** for the small-string case — that's the real success metric.
- Confirm numeric constants and the `AST_This` alias path are **unaffected** by the
  option (only `AST_String` replacements are discounted).

### Done when
- Regression guard passes.
- Feature 1: mangle-off + `assume_mangled` matches `mangle:true` keep/inline decisions;
  globals/exports unaffected.
- Feature 2: `> 1` inlines repeated small strings; post-gzip size drops; numbers/`this`
  untouched; default `1` is an exact no-op.
- `AST_Symbol._size` body and `_mangle_options` semantics untouched.

---

## 6. Notes & cautions

- **Composition:** both options operate on opposite sides of the same inline
  inequality and can be used together; expect no cross-interaction.
- **Feature 2 trades pre-gzip bytes for post-gzip bytes.** It's only a win when
  the shipped artifact is gzip/brotli-compressed. Anyone serving these files
  uncompressed would regress — document this on the option.
- **Pass-1 inlining is baked in.** Strings inlined in pass 1 cannot be re-shared
  by the downstream mangle pass (terser has no literal-extraction transform).
  That's fine here because inlining is the goal and is stable through pass 2.
- **Naming:** snake_case to match terser house style
  (`assume_mangled`, `inline_string_aggressiveness`).
- **Versioning:** pinned to terser 5.48.0. If bumping terser, re-verify the line
  anchors (`size.js` ambient capture, `index.js` defaults + `_mangle_options`,
  `inline.js` multi-use branch) — they may shift.
