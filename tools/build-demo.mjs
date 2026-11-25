// Builds one self-contained demo page: the app, sample data and fonts inlined,
// opening straight into demo mode. No dependencies.
// Usage: node tools/build-demo.mjs out.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || 'demo.html';
// --fragment: no doctype/html/head/body, for hosts that wrap the page themselves.
const fragment = process.argv.includes('--fragment');
const ORDER = ['logic.js', 'demo.js', 'store.js', 'app.js']; // dependencies first
const modName = (f) => '__' + f.replace(/\W/g, '_');

/** Turns one ES module into an IIFE that returns its exports. Handles only the import/export forms this app uses. */
function wrap(file) {
  let src = fs.readFileSync(path.join(root, file), 'utf8');
  const exported = [];
  src = src.replace(/^import \* as (\w+) from '\.\/([\w.]+)';$/gm, (_, ns, f) => `const ${ns} = ${modName(f)};`);
  src = src.replace(/^import \{([^}]+)\} from '\.\/([\w.]+)';$/gm, (_, names, f) => `const {${names}} = ${modName(f)};`);
  src = src.replace(/^export (async function|function|const|let) (\w+)/gm, (_, kind, name) => {
    exported.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*(import|export)\s/m.test(src)) throw new Error('Unhandled import/export in ' + file);
  return `const ${modName(file)} = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();\n`;
}

const js = ORDER.map(wrap).join('\n');
let css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
css = css.replace(/url\("fonts\/([^"]+)"\)/g, (_, f) =>
  `url("data:font/woff2;base64,${fs.readFileSync(path.join(root, 'fonts', f)).toString('base64')}")`);

const page = `<title>Ruthines demo</title>
<style>
${css}
</style>
<div id="app"><p style="padding:1rem">Loading…</p></div>
<script>
self.RUTHINES_DEMO = true;
${js.replace(/<\/script/gi, '<\\/script')}
</script>
`;
const html = fragment ? page : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${page.replace('<div id="app">', '</head>\n<body>\n<div id="app">')}</body>
</html>
`;
fs.writeFileSync(out, html);
console.log('wrote', out, Math.round(html.length / 1024) + ' KB');
