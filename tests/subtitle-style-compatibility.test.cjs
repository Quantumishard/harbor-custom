const fs = require("node:fs"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const ts = require(root + "/node_modules/typescript");
const source = fs.readFileSync(root + "/src/lib/player/sub-style.ts", "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const props = new Map();
const context = {
  exports: {},
  require: () => ({
    invoke: (_command, args) => {
      props.set(args.name, args.value);
      return Promise.resolve();
    },
  }),
};
vm.runInNewContext(code, context);
// A leftover saved value from the reverted build must have no effect.
const settings = {
  subAssOverride: "no",
  subUseTextColor: true,
  subFontColor: "#FFFFFF",
  subOpacity: 1,
  subFontFamily: "system",
  subFontSize: 32,
  subStyle: "shadow",
  subBorderColor: "#000000",
  subBorderSize: 2,
  subBoxColor: "#000000",
  subBoxOpacity: 0.6,
  subMarginY: 5,
  subAlignX: "center",
  subLineSpacing: 0,
};
(async () => {
  await context.exports.applySubStyle(settings, {
    assNativeActive: false,
    imageNativeActive: true,
  });
  assert.equal(
    props.get("sub-ass-override"),
    "no",
    "PGS must not enable style/position overrides implicitly",
  );
  assert.equal(props.has("sub-ass-style-overrides"), false);
  assert.equal(props.has("sub-hdr-peak"), false);
  assert.equal(props.get("sub-color"), "#FFFFFFFF");
  assert.equal(props.get("sub-pos"), 95);
  await context.exports.applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
  });
  assert.equal(props.get("sub-ass-override"), "no");
  assert.equal(props.get("sub-pos"), 100);
  assert.equal(props.get("sub-ass-force-margins"), "no");
  await context.exports.applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
    assScale: 1.2,
  });
  assert.equal(props.get("sub-ass-override"), "scale");
  assert.equal(props.get("sub-scale"), 1.2);
  await context.exports.applySubStyle({
    ...settings,
    subAssOverride: "force",
    subFontColor: "#123456",
    subOpacity: 0.5,
  });
  assert.equal(
    props.get("sub-ass-override"),
    "force",
    "Explicit user styling must remain supported",
  );
  assert.equal(props.get("sub-color"), "#80123456");
  console.log(
    "PASS: PGS no implicit override, original ASS placement/normalization, explicit styling, legacy saved setting ignored, no added color/HDR overrides",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
