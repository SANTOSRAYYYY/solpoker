// 部署前依赖审计：把 web/ 里「直接 import 的包」与 package.json 的 dependencies 对照，
// 抓出"本地能跑、Vercel 干净安装后会炸"的传递依赖（2026-10-08 实测：
// @solana/spl-token 就是这样漏掉的，首次部署因此构建失败）。
//
// 用法（仓库根目录或 web/ 均可）：
//   node scripts/check-web-deps.mjs
import fs from "node:fs";
import path from "node:path";

const web = path.resolve("web");
const deps = new Set(
  Object.keys(JSON.parse(fs.readFileSync(path.join(web, "package.json"), "utf8")).dependencies ?? {})
);

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) files.push(p);
  }
};
for (const d of ["app", "lib", "components"]) walk(path.join(web, d));

const bare = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import[^'"]*from\s*|import\s*)"([^"]+)"|require\("([^"]+)"\)/g)) {
    const spec = m[1] ?? m[2];
    if (!spec || spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("node:")) continue;
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    bare.add(pkg);
  }
}

const missing = [...bare]
  .filter((b) => !deps.has(b) && !["react", "react-dom", "next"].includes(b))
  .sort();

if (missing.length) {
  console.error(`✗ 有直接 import 但未声明的依赖（Vercel 上会构建失败）：\n  ${missing.join("\n  ")}`);
  console.error(`\n修：cd web && npm install <pkg>@<本机已装版本> --save`);
  process.exit(1);
}
console.log(`WEB_DEPS_OK — ${bare.size} 个直接依赖全部已声明`);
