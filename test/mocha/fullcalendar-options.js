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
                string_inline_aggressiveness: 1,
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
});
