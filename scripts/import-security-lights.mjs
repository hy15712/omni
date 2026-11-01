// 보안등 공공데이터(전국보안등정보표준데이터 형식 CSV)를 조사 범위 안만 골라 data/streetlights.js 로 만듭니다.
// 실행: node scripts/import-security-lights.mjs <보안등.csv>
//   - 열: 보안등위치명, 설치개수, 소재지도로명주소, 소재지지번주소, 위도, 경도, 설치형태, 관리기관명, 데이터기준일자 …
//   - 지도 표시: type "보안등", 확인 방법 ‘기관확인’, 자료 기준일 = 데이터기준일자, 출처 = 관리기관명
// 지금 들어 있는 것: 서울특별시 종로구 보안등(2026-07-03 기준). 중구 보안등·큰길 가로등은 자료를 찾으면 같은 형식으로 추가.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2];
if (!file) { console.error("사용법: node scripts/import-security-lights.mjs <보안등.csv>"); process.exit(1); }

// 따옴표를 지원하는 작은 CSV 파서
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
let text = fs.readFileSync(file);
text = new TextDecoder(text[0] === 0xEF ? "utf-8" : "euc-kr").decode(text).replace(/^﻿/, "");
const [hdr, ...body] = parseCsv(text).filter(r => r.length > 1);
const col = name => { const i = hdr.indexOf(name); if (i < 0) throw new Error(`열 ‘${name}’ 이(가) 없습니다: ${hdr.join(", ")}`); return i; };
const C = { name: col("보안등위치명"), count: col("설치개수"), road: col("소재지도로명주소"), lot: col("소재지지번주소"),
  lat: col("위도"), lng: col("경도"), mount: col("설치형태"), org: col("관리기관명"), date: col("데이터기준일자") };

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "data/bounds.js"), "utf8"), ctx);
const B = ctx.window.SURVEY_BOUNDS;
const inside = (la, lo) => la >= B.south && la <= B.north && lo >= B.west && lo <= B.east;

const out = [], dates = new Set(), seen = new Set();
for (const r of body) {
  const lat = parseFloat(r[C.lat]), lng = parseFloat(r[C.lng]);
  if (!(lat && lng) || !inside(lat, lng)) continue;
  const name = r[C.name].trim(), id = `sl-${name}`;
  if (seen.has(id)) continue; seen.add(id);
  dates.add(r[C.date]);
  out.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), count: parseInt(r[C.count], 10) || 1, type: "보안등", id,
    location: r[C.road] || r[C.lot], ...(r[C.mount] ? { mount: r[C.mount] } : {}),
    verification: { status: "agency", date: r[C.date], by: `${r[C.org]} (보안등 공공데이터)` } });
}
out.sort((a, b) => a.id.localeCompare(b.id, "ko"));
const header = `// 가로등·보안등 위치 — 지도의 가로등 격자에 쓰는 공공데이터. scripts/import-security-lights.mjs 로 만듦(직접 고치지 말 것)
// 지금: 서울특별시 종로구 보안등(자료 기준일 ${[...dates].join(", ")}, 전국보안등정보표준데이터) 중 조사 범위 안 ${out.length}곳
// 중구 보안등·큰길 가로등은 아직 없음. 현장 조사로 기록한 가로등은 data/streetlights-survey.js 에 따로 보관(지도에 표시 안 함)
// count: 그 지점의 등 개수(쌍등이면 2) / type: "가로등" | "보안등" / mount: 설치 형태(건축물·한전주·전용주)`;
fs.writeFileSync(path.join(ROOT, "data/streetlights.js"), `${header}\nwindow.STREETLIGHTS = [\n${out.map(v => "  " + JSON.stringify(v) + ",").join("\n")}\n];\n`);
console.log(`조사 범위 안 ${out.length}곳(등 ${out.reduce((s, l) => s + l.count, 0)}개) → data/streetlights.js · 자료 기준일 ${[...dates].join(", ")}`);
