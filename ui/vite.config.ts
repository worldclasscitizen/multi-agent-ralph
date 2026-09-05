import { copyFile, readFile, writeFile } from "node:fs/promises";
import { defineConfig } from "vite";
export default defineConfig({
  plugins: [
    {
      name: "local-elk",
      async closeBundle() {
        await copyFile(
          "node_modules/elkjs/lib/elk.bundled.js",
          "assets/dashboard/elk.bundled.js",
        );
        const packages = new Set([
          "elkjs",
          ...[...this.getModuleIds()]
            .map(
              (id) =>
                id
                  .replaceAll("\\", "/")
                  .match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1],
            )
            .filter((name): name is string => Boolean(name)),
        ]);
        const notices: string[] = [];
        for (const name of [...packages].sort()) {
          for (const file of [
            "LICENSE",
            "LICENSE.md",
            "LICENSE.txt",
            "license",
          ]) {
            try {
              notices.push(
                `${name}\n${await readFile(`node_modules/${name}/${file}`, "utf8")}`,
              );
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
        }
        await writeFile(
          "assets/dashboard/THIRD_PARTY_NOTICES.txt",
          notices.join("\n\n"),
        );
      },
    },
  ],
  base: "/",
  build: {
    outDir: "../assets/dashboard",
    emptyOutDir: false,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names?.some((n) => n.endsWith(".css"))
            ? "styles.css"
            : "[name][extname]",
      },
    },
  },
});
