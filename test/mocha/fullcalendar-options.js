import assert from "assert";
import { gzipSync } from "zlib";
import { minify } from "../../main.js";

describe("fullcalendar compress options", function() {
    it("keeps output byte-identical when fork options are left at defaults", async function() {
        const code = `function f(a) {
            const s = "ab";
            const n = 12;
            return a ? s + n : (a + s + s + s + n);
        }
        window.f = f;`;

        const implicit_result = await minify(code, {
            compress: {},
            mangle: false,
        });
        const explicit_result = await minify(code, {
            compress: {
                assume_mangled: false,
                number_inline_aggressiveness: 1,
                string_inline_aggressiveness: 1,
                string_inline_lte_length: -1,
            },
            mangle: false,
        });

        assert.strictEqual(explicit_result.code, implicit_result.code);
    });

    it("sizes local names as mangled when assume_mangled is enabled", async function() {
        const code = `function f(){
            var someLongLocalNameThatIsExpensiveToKeepRepeating = "aLongishStringConstant";
            return [
                someLongLocalNameThatIsExpensiveToKeepRepeating,
                someLongLocalNameThatIsExpensiveToKeepRepeating,
                someLongLocalNameThatIsExpensiveToKeepRepeating
            ];
        }
        window.f = f;`;

        const default_result = await minify(code, {
            compress: {},
            mangle: false,
        });
        const assumed_result = await minify(code, {
            compress: { assume_mangled: true },
            mangle: false,
        });
        const mangled_result = await minify(code, {
            compress: {},
            mangle: true,
        });

        assert.strictEqual(
            default_result.code,
            'function f(){return["aLongishStringConstant","aLongishStringConstant","aLongishStringConstant"]}window.f=f;'
        );
        assert.strictEqual(
            assumed_result.code,
            'function f(){var someLongLocalNameThatIsExpensiveToKeepRepeating="aLongishStringConstant";return[someLongLocalNameThatIsExpensiveToKeepRepeating,someLongLocalNameThatIsExpensiveToKeepRepeating,someLongLocalNameThatIsExpensiveToKeepRepeating]}window.f=f;'
        );
        assert.strictEqual(
            mangled_result.code,
            'function f(){var n="aLongishStringConstant";return[n,n,n]}window.f=f;'
        );
    });

    it("does not treat globals as mangled under assume_mangled", async function() {
        const code = `function f(x, y) {
            var z = BigInt(x) * BigInt(y);
            return [z, z, z];
        }
        window.f = f;`;

        const default_result = await minify(code, {
            compress: {},
            mangle: false,
        });
        const assumed_result = await minify(code, {
            compress: { assume_mangled: true },
            mangle: false,
        });

        assert.strictEqual(assumed_result.code, default_result.code);
        assert.strictEqual(
            assumed_result.code,
            "function f(x,y){var z=BigInt(x)*BigInt(y);return[z,z,z]}window.f=f;"
        );
    });

    it("inlines repeated strings more aggressively when configured", async function() {
        const code = `function f(a) {
            const s = "ab";
            return a ? s : (a + s + s + s);
        }
        window.f = f;`;

        const default_result = await minify(code, {
            compress: { string_inline_aggressiveness: 1 },
            mangle: false,
        });
        const aggressive_result = await minify(code, {
            compress: { string_inline_aggressiveness: 1.5 },
            mangle: false,
        });

        assert.strictEqual(
            default_result.code,
            'function f(a){const s="ab";return a?s:a+s+s+s}window.f=f;'
        );
        assert.strictEqual(
            aggressive_result.code,
            'function f(a){return a?"ab":a+"ababab"}window.f=f;'
        );
        assert.ok(
            gzipSync(aggressive_result.code).length < gzipSync(default_result.code).length,
            "aggressive string inlining should reduce gzipped output for this small repeated string"
        );
    });

    it("forces strings at or below string_inline_lte_length to inline", async function() {
        const code = `function f(a) {
            const s = "abcdefghi";
            return a ? s : (a + s + s + s);
        }
        window.f = f;`;

        const default_result = await minify(code, {
            compress: {},
            mangle: false,
        });
        const below_threshold_result = await minify(code, {
            compress: { string_inline_lte_length: 8 },
            mangle: false,
        });
        const threshold_result = await minify(code, {
            compress: { string_inline_lte_length: 9 },
            mangle: false,
        });
        const threshold_beats_aggressiveness_result = await minify(code, {
            compress: {
                string_inline_aggressiveness: 0.01,
                string_inline_lte_length: 9,
            },
            mangle: false,
        });

        assert.strictEqual(
            default_result.code,
            'function f(a){const s="abcdefghi";return a?s:a+s+s+s}window.f=f;'
        );
        assert.strictEqual(below_threshold_result.code, default_result.code);
        assert.strictEqual(
            threshold_result.code,
            'function f(a){return a?"abcdefghi":a+"abcdefghiabcdefghiabcdefghi"}window.f=f;'
        );
        assert.strictEqual(threshold_beats_aggressiveness_result.code, threshold_result.code);
    });

    it("does not apply string_inline_lte_length to longer strings or numeric constants", async function() {
        const short_string_code = "function f(a){const s=\"ab\";return a?s:a+s+s+s}window.f=f;";
        const long_string_code = "function f(a){const s=\"abcdefghi\";return a?s:a+s+s+s}window.f=f;";
        const numeric_code = "function f(a){const n=123456789;return a?n:a+n+n+n}window.f=f;";

        const default_short_string = await minify(short_string_code, {
            compress: {},
            mangle: false,
        });
        const threshold_short_string = await minify(short_string_code, {
            compress: { string_inline_lte_length: 1 },
            mangle: false,
        });
        const default_long_string = await minify(long_string_code, {
            compress: {},
            mangle: false,
        });
        const threshold_long_string = await minify(long_string_code, {
            compress: { string_inline_lte_length: 8 },
            mangle: false,
        });
        const default_numeric = await minify(numeric_code, {
            compress: {},
            mangle: false,
        });
        const threshold_numeric = await minify(numeric_code, {
            compress: { string_inline_lte_length: 9 },
            mangle: false,
        });

        assert.strictEqual(threshold_short_string.code, default_short_string.code);
        assert.strictEqual(threshold_long_string.code, default_long_string.code);
        assert.strictEqual(threshold_numeric.code, default_numeric.code);
    });

    it("does not apply string_inline_aggressiveness to numeric constants or this aliases", async function() {
        const numeric_code = "function f(a){const n=12;return a?n:a+n+n+n}window.f=f;";
        const this_code = "function f(){var self=this;return [self,self,self,self]}window.f=f;";

        const default_numeric = await minify(numeric_code, {
            compress: {},
            mangle: false,
        });
        const aggressive_numeric = await minify(numeric_code, {
            compress: { string_inline_aggressiveness: 3 },
            mangle: false,
        });
        const default_this = await minify(this_code, {
            compress: {},
            mangle: false,
        });
        const aggressive_this = await minify(this_code, {
            compress: { string_inline_aggressiveness: 3 },
            mangle: false,
        });

        assert.strictEqual(aggressive_numeric.code, default_numeric.code);
        assert.strictEqual(aggressive_this.code, default_this.code);
    });

    it("inlines repeated numbers more aggressively when configured", async function() {
        const code = "function f(a){const n=123456789;return a?n:a+n+n+n}window.f=f;";

        const default_result = await minify(code, {
            compress: { number_inline_aggressiveness: 1 },
            mangle: false,
        });
        const aggressive_result = await minify(code, {
            compress: { number_inline_aggressiveness: 3 },
            mangle: false,
        });

        assert.strictEqual(
            default_result.code,
            "function f(a){const n=123456789;return a?n:a+n+n+n}window.f=f;"
        );
        assert.strictEqual(
            aggressive_result.code,
            "function f(a){return a?123456789:a+123456789+123456789+123456789}window.f=f;"
        );
    });

    it("does not apply number_inline_aggressiveness to strings or this aliases", async function() {
        const string_code = "function f(a){const s=\"ab\";return a?s:a+s+s+s}window.f=f;";
        const this_code = "function f(){var self=this;return [self,self,self,self]}window.f=f;";

        const default_string = await minify(string_code, {
            compress: {},
            mangle: false,
        });
        const aggressive_string = await minify(string_code, {
            compress: { number_inline_aggressiveness: 3 },
            mangle: false,
        });
        const default_this = await minify(this_code, {
            compress: {},
            mangle: false,
        });
        const aggressive_this = await minify(this_code, {
            compress: { number_inline_aggressiveness: 3 },
            mangle: false,
        });

        assert.strictEqual(aggressive_string.code, default_string.code);
        assert.strictEqual(aggressive_this.code, default_this.code);
    });
});
