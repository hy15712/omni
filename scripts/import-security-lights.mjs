// 보안등 공공데이터(전국보안등정보표준데이터 형식 CSV)를 조사 범위 안만 골라 data/streetlights.js 로 만듭니다.
// 실행: node scripts/import-security-lights.mjs <종로구 보안등.csv> <중구 보안등.csv> …  (여러 구 파일을 한 번에)
//   - 열: 보안등위치명, 설치개수, 소재지도로명주소, 소재지지번주소, 위도, 경도, 설치형태, 관리기관명, 데이터기준일자 …
//   - 지도 표시: type "보안등", 확인 방법 ‘기관확인’, 자료 기준일 = 데이터기준일자, 출처 = 관리기관명
// 지금 들어 있는 것: 종로구 보안등(2026-07-03 기준) + 중구 보안등(2025-10-31 기준). 큰길 가로등은 자료를 찾으면 추가.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = process.argv.slice(2);
if (!files.length) { console.error("사용법: node scripts/import-security-lights.mjs <보안등.csv> [<보안등.csv> …]"); process.exit(1); }

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

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "data/bounds.js"), "utf8"), ctx);
const B = ctx.window.SURVEY_BOUNDS;
const inside = (la, lo) => la >= B.south && la <= B.north && lo >= B.west && lo <= B.east;

const out = [], sources = new Map(), seen = new Set();
for (const file of files) {
  const raw = fs.readFileSync(file);
  const text = new TextDecoder(raw[0] === 0xEF ? "utf-8" : "euc-kr").decode(raw).replace(/^﻿/, "");
  const [hdr, ...body] = parseCsv(text).filter(r => r.length > 1);
  const col = name => { const i = hdr.indexOf(name); if (i < 0) throw new Error(`${file}: 열 ‘${name}’ 이(가) 없습니다: ${hdr.join(", ")}`); return i; };
  const C = { name: col("보안등위치명"), count: col("설치개수"), road: col("소재지도로명주소"), lot: col("소재지지번주소"),
    lat: col("위도"), lng: col("경도"), mount: col("설치형태"), org: col("관리기관명"), date: col("데이터기준일자") };
  for (const r of body) {
    const lat = parseFloat(r[C.lat]), lng = parseFloat(r[C.lng]);
    if (!(lat && lng) || !inside(lat, lng)) continue;
    const gu = (r[C.road] || r[C.lot]).split(/\s+/)[1] || "";   // 종로구 / 중구 — 구마다 번호 체계가 달라 id 앞에 붙임
    const id = `sl-${gu}-${r[C.name].trim()}`;
    if (seen.has(id)) continue; seen.add(id);
    const src = `${gu} 보안등(${r[C.date]} 기준)`; sources.set(src, (sources.get(src) || 0) + 1);
    out.push({ lat: +lat.toFixed(6), lng: +lng.toFixed(6), count: parseInt(r[C.count], 10) || 1, type: "보안등", id,
      location: r[C.road] || r[C.lot], ...(r[C.mount] ? { mount: r[C.mount] } : {}),
      verification: { status: "agency", date: r[C.date], by: `${r[C.org]} (보안등 공공데이터)` } });
  }
}
out.sort((a, b) => a.id.localeCompare(b.id, "ko"));
const summary = [...sources].map(([k, v]) => `${k} ${v}곳`).join(" · ");
const header = `// 가로등·보안등 위치 — 지도의 가로등 격자에 쓰는 공공데이터. scripts/import-security-lights.mjs 로 만듦(직접 고치지 말 것)
// 지금: ${summary} (전국보안등정보표준데이터, 조사 범위 안만)
// 큰길 가로등은 아직 없음. 현장 조사 가로등은 data/streetlights-survey.js 에 따로 있고, 지도(app.js)는 그중 큰길가 것만(data/big-roads.js) 함께 표시
// count: 그 지점의 등 개수(쌍등이면 2) / type: "가로등" | "보안등" / mount: 설치 형태(건축물·한전주·전용주)`;
fs.writeFileSync(path.join(ROOT, "data/streetlights.js"), `${header}\nwindow.STREETLIGHTS = [\n${out.map(v => "  " + JSON.stringify(v) + ",").join("\n")}\n];\n`);
console.log(`조사 범위 안 ${out.length}곳(등 ${out.reduce((s, l) => s + l.count, 0)}개) → data/streetlights.js · ${summary}`);
