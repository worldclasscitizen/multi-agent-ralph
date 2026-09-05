import { createPrivateKey, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, isAbsolute, relative } from "node:path";

const privateKeyPath = process.env.RALPH_CATALOG_PRIVATE_KEY;
if (!privateKeyPath) throw new Error("RALPH_CATALOG_PRIVATE_KEY에 저장소 밖 Ed25519 private key 절대 경로가 필요합니다.");
if (!isAbsolute(privateKeyPath)) throw new Error("private key는 절대 경로로 지정해야 합니다.");
const relativeKey = relative(process.cwd(), resolve(privateKeyPath));
if (!relativeKey.startsWith("..") && !isAbsolute(relativeKey)) throw new Error("Signing key must stay outside the repository");
const catalogPath = resolve(process.argv[2] ?? "assets/catalog-v2.json");
const signaturePath = resolve(process.argv[3] ?? "assets/catalog-v2.sig");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const canonical = Buffer.from(JSON.stringify(catalog));
const privateKey = createPrivateKey(await readFile(privateKeyPath));
const signature = sign(null, canonical, privateKey).toString("base64");
await writeFile(signaturePath, `${signature}\n`, { mode: 0o644 });
process.stdout.write(`서명을 작성했습니다: ${signaturePath}\n`);
