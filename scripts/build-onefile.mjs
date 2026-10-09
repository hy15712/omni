// 카톡 등으로 보낼 한 파일짜리 HTML 만들기: index.html 에 style/survey CSS, data/*.js, app.js, survey.js 를 넣어 합칩니다.
// 실행: node scripts/build-onefile.mjs  →  종로보행지도_한파일.html
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
let html = read("index.html")
  .replace(/<link rel="stylesheet" href="((?!https?:)[^"]+)">/g, (_, f) => `<style>/* ${f} */\n${read(f)}</style>`)
  .replace(/<script src="((?!https?:)[^"]+)"><\/script>/g, (_, f) => `<script>/* ${f} */\n${read(f)}</script>`);
if (/(href|src)="(?!https?:)[^"]+\.(css|js)"/.test(html)) throw new Error("합치지 못한 파일이 남아 있습니다.");
fs.writeFileSync(path.join(ROOT, "종로보행지도_한파일.html"), html);
console.log("종로보행지도_한파일.html 을 만들었습니다.");
