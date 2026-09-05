import { readFile, readdir, access } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
const root = resolve(import.meta.dirname, ".."),
  failures = [];
async function walk(dir) {
  return (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true }))
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : join(dir, e.name),
        ),
    )
  ).flat();
}
const docs = [
  join(root, "README.md"),
  join(root, "README.ko.md"),
  join(root, "START_HERE.md"),
  ...(await walk(join(root, "docs"))).filter((p) => p.endsWith(".md")),
];
for (const file of docs) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(
    /\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g,
  )) {
    const href = match[1].replace(/^<|>$/g, "").split("#")[0];
    if (!href || /^(?:https?:|mailto:|data:)/.test(href)) continue;
    const path = href.startsWith("/")
      ? join(root, "docs", href)
      : resolve(dirname(file), href);
    let found = false;
    for (const candidate of [path, path + ".md", join(path, "index.md")])
      try {
        await access(candidate);
        found = true;
        break;
      } catch {}
    if (!found) failures.push(`Broken link: ${file} -> ${href}`);
  }
}
const en = await readFile(docs[0], "utf8"),
  ko = await readFile(docs[1], "utf8");
const commands = (s) =>
  s
    .split(/\r?\n/)
    .filter((l) => /^(ralph |npm )/.test(l))
    .sort()
    .join("\n");
if (commands(en) !== commands(ko))
  failures.push("README command parity failed");
if ((en.match(/^## /gm) ?? []).length !== (ko.match(/^## /gm) ?? []).length)
  failures.push("README section parity failed");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
for (const file of docs.slice(0, 2)) {
  if (
    !(await readFile(file, "utf8")).includes(pkg.version.replaceAll("-", "--"))
  )
    failures.push(`README version badge differs: ${file}`);
}
const blocked = [
  [83, 119, 97, 114, 109, 32, 68, 105, 115, 112, 97, 116, 99, 104],
  [83, 104, 97, 114, 100],
  [70, 97, 105, 108, 111, 118, 101, 114],
  [68, 97, 101, 109, 111, 110, 32, 80, 114, 111, 99, 101, 115, 115],
].map((c) => new RegExp("\\b" + String.fromCharCode(...c) + "\\b", "i"));
for (const file of [
  ...docs,
  ...(await walk(join(root, "src"))),
  ...(await walk(join(root, "ui"))),
  ...(await walk(join(root, "integrations"))),
])
  if (/\.(?:ts|tsx|md|mjs|js|json|css)$/.test(file)) {
    const text = await readFile(file, "utf8");
    if (blocked.some((re) => re.test(text)))
      failures.push(`Terminology constraint: ${file}`);
    if (text.includes("worldclasscitizen/multi-agent-ralph"))
      failures.push(`Outdated repository URL: ${file}`);
  }
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `OK: ${docs.length} documents, links, terminology, README commands and version parity`,
  );
