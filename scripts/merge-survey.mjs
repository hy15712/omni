// 조사 기록 합치기 — 조사 입력 모드에서 내보낸 zip을 data/*.js 에 합칩니다.
//
// 1) zip을 survey-inbox/ 에 풀어 넣기 (zip 하나당 폴더 하나, 안에 survey.json + photos/)
// 2) node scripts/merge-survey.mjs          → survey-inbox/검토.md, decisions.json 만 만듦(데이터는 그대로)
// 3) decisions.json 의 "ask"(중복 후보)를 정함:
//      "new"            새 항목으로 추가
//      "confirm:<id>"   기존 항목을 다시 확인한 것 → 최종확인 날짜·확인자만 갱신, 새 사진은 덧붙임
//      "replace:<id>"   기존 항목을 조사 값으로 바꿈(id 유지)
//      "skip"           버림
// 4) node scripts/merge-survey.mjs --apply  → data/places.js, roads.js, streetlights.js 갱신, 사진은 photos/ 로 복사
//
// 이미 합친 기록은 survey-inbox/applied.json 에 남아 다음 실행 때 건너뜁니다.
// survey-inbox/ 는 조사자 이름이 들어 있어 저장소에 올리지 않습니다(.gitignore).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = path.join(ROOT, "survey-inbox");
const DUP_M = 10;            // 같은 분류가 이 거리 안에 있으면 중복 후보
const GPS_WARN_M = 15;
const APPLY = process.argv.includes("--apply");

const LABEL = { toilet:"화장실", bench:"벤치", stairs:"계단", aed:"AED", hospital:"병원", pharmacy:"약국",
  fire:"소방서", police:"지구대", trash:"쓰레기통", streetlight:"가로등", road:"보행 구간" };
const DETAIL_KEYS = { toilet:["location","accessibleStall","open","approach"], stairs:["steps","location","handrail","altRoute"],
  bench:["count","location"], aed:["location"], trash:["location","recycling"] };
const HOURS_CATS = ["toilet", "aed"];
const ROAD_LABEL = { sidewalk:"인도", roadway:"차도", shared:"보차혼용" };

const readJson = (f, fallback) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : fallback;
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");

// ── 데이터 파일 읽기/쓰기 ─────────────────────────
function loadData(file, prop) {
  const src = fs.readFileSync(path.join(ROOT, "data", file), "utf8");
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx);
  const header = [];
  for (const line of src.split("\n")) { if (line.startsWith("//") || line.trim() === "") header.push(line); else break; }
  return { value: ctx.window[prop], header: header.join("\n").trimEnd() };
}
const line = v => "  " + JSON.stringify(v) + ",";
function saveData(file, header, body) {
  fs.writeFileSync(path.join(ROOT, "data", file), `${header}\n${body}\n`);
}

// ── 거리 계산 ────────────────────────────────────
function dist(a, b) {   // [lat,lng] 두 점 사이 미터
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const ends = coords => [coords[0], coords.at(-1)].map(([lng, lat]) => [lat, lng]);
function roadDist(c1, c2) {   // 양 끝점끼리 거리(방향 무관) 중 큰 값
  const [a1, a2] = ends(c1), [b1, b2] = ends(c2);
  return Math.min(Math.max(dist(a1, b1), dist(a2, b2)), Math.max(dist(a1, b2), dist(a2, b1)));
}

// ── 조사 기록 → 지도 데이터 형식 ───────────────────
// 조사 때 ‘–’(입력 안 함)으로 둔 칸은 data 에 키가 없음 → 지도 데이터에도 넣지 않아 정보창에 줄이 안 나옴
const only = (d, keys) => Object.fromEntries(keys.filter(k => d[k] !== undefined).map(k => [k, d[k]]));
function toEntry(rec) {
  const d = rec.data || {}, v = { status: "field", date: rec.surveyDate, by: rec.surveyor };
  if (rec.kind === "road") return { type: "Feature",
    properties: { id: null, name: d.name || `${ROAD_LABEL[d.type] || "보행"} 구간`, type: d.type,
      ...only(d, ["widthM", "surface", "curbCut", "slopeNote"]), verification: v, coordSource: rec.coordSource },
    geometry: { type: "LineString", coordinates: rec.coords } };
  if (rec.kind === "light") return { lat: rec.lat, lng: rec.lng, count: d.count ?? null, type: d.type || "미상", id: null,
    ...(d.location ? { location: d.location } : {}), verification: v, coordSource: rec.coordSource };
  const keys = DETAIL_KEYS[rec.category] || [];
  const details = only(d, keys);
  const name = d.name || `${LABEL[rec.category]}${d.location ? " · " + d.location : ""}`;
  return { id: null, category: rec.category, name, lat: rec.lat, lng: rec.lng, details,
    ...(HOURS_CATS.includes(rec.category) ? (d.hours !== undefined ? { hours: d.hours } : {}) : { hours: null }),
    verification: v, coordSource: rec.coordSource };
}
const posOf = (kind, e) => kind === "road" ? null : [e.lat, e.lng];
function changes(oldE, newE, kind, hasName) {   // 값이 달라진 칸 (접근경로처럼 묶인 칸은 풀어서 비교)
  const flat = (o, pre = "") => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) && k !== "hours" ? flat(v, pre + k + ".") : [[pre + k, v]]);
  const pick = e => Object.fromEntries(flat(kind === "road" ? (({ id, verification, coordSource, photos, ...p }) => p)(e.properties)
    : kind === "light" ? { count: e.count, type: e.type }
    : { ...(hasName ? { name: e.name } : {}), ...Object.fromEntries(Object.entries(e.details).filter(([k]) => k !== "photos")), hours: e.hours }));
  const a = pick(oldE), b = pick(newE), out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (b[k] == null) continue;     // 조사에서 ‘모름’인 칸은 비교하지 않음
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k])) out.push(`${k}: ${JSON.stringify(a[k] ?? null)} → ${JSON.stringify(b[k])}`);
  }
  return out;
}

// ── 받은 기록 모으기 ─────────────────────────────
if (!fs.existsSync(INBOX)) { console.error("survey-inbox/ 폴더가 없습니다."); process.exit(1); }
const applied = readJson(path.join(INBOX, "applied.json"), {});
const inbox = [];
for (const dir of fs.readdirSync(INBOX).sort()) {
  const f = path.join(INBOX, dir, "survey.json");
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  if (j.format !== "walkmap-survey") { console.warn(`${dir}: 조사 기록 형식이 아니라 건너뜀`); continue; }
  for (const rec of j.records) inbox.push({ rec, dir });
}
// 같은 기록이 여러 zip에 있으면(다시 내보낸 경우) 가장 최근 수정본만
const latest = new Map();
for (const it of inbox) { const p = latest.get(it.rec.id); if (!p || it.rec.updatedAt > p.rec.updatedAt) latest.set(it.rec.id, it); }
const items = [...latest.values()].filter(it => !applied[it.rec.id])
  .sort((a, b) => (a.rec.surveyDate + a.rec.createdAt).localeCompare(b.rec.surveyDate + b.rec.createdAt));

const places = loadData("places.js", "PLACES"), roads = loadData("roads.js", "ROADS"), lights = loadData("streetlights.js", "STREETLIGHTS");
const bounds = (() => { const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(ROOT, "data/bounds.js"), "utf8"), ctx); return ctx.window.SURVEY_BOUNDS; })();
const inBounds = ([lat, lng]) => lat >= bounds.south && lat <= bounds.north && lng >= bounds.west && lng <= bounds.east;

// ── 중복 후보 찾기 ───────────────────────────────
function existingPool(kind, category) {
  if (kind === "road") return roads.value.features.map(f => ({ id: f.properties.id, label: f.properties.name, entry: f }));
  if (kind === "light") return lights.value.map(l => ({ id: l.id, label: `${l.type} ${l.count ?? "?"}개`, entry: l }));
  return places.value.filter(p => p.category === category).map(p => ({ id: p.id, label: p.name, entry: p }));
}
const decisionsFile = path.join(INBOX, "decisions.json");
const decisions = readJson(decisionsFile, {});
const report = [];
for (const it of items) {
  const { rec } = it, entry = toEntry(rec), kind = rec.kind;
  const near = [];
  for (const c of existingPool(kind, rec.category)) {
    const m = kind === "road" ? roadDist(rec.coords, c.entry.geometry.coordinates) : dist(posOf(kind, entry), posOf(kind, c.entry));
    if (m <= DUP_M) near.push({ ...c, m: Math.round(m * 10) / 10, diff: changes(c.entry, entry, kind, !!rec.data?.name) });
  }
  // 이번에 받은 기록끼리도(두 사람이 같은 곳을 기록한 경우)
  for (const o of report) {
    if (o.rec.category !== rec.category) continue;
    const m = kind === "road" ? roadDist(rec.coords, o.rec.coords) : dist([rec.lat, rec.lng], [o.rec.lat, o.rec.lng]);
    if (m <= DUP_M) near.push({ id: `inbox:${o.rec.id}`, label: `이번에 받은 기록 (${o.rec.surveyor}, ${o.rec.surveyDate})`, m: Math.round(m * 10) / 10, diff: [] });
  }
  near.sort((a, b) => a.m - b.m);
  const warn = [];
  const p0 = kind === "road" ? [rec.coords[0][1], rec.coords[0][0]] : [rec.lat, rec.lng];
  if (!inBounds(p0)) warn.push("조사 범위 밖");
  if (rec.gpsAccuracy > GPS_WARN_M) warn.push(`GPS 정확도 ±${rec.gpsAccuracy}m`);
  if (HOURS_CATS.includes(rec.category) && !rec.photos?.length) warn.push("위치 사진 없음");
  if (kind === "light" && rec.data?.count == null) warn.push("개수 모름(지도에선 1개로 셈)");
  decisions[rec.id] ??= near.length ? "ask" : "new";
  report.push({ ...it, entry, near, warn });
}

// ── 검토 보고서 ──────────────────────────────────
const summaryOf = (rec, entry) => rec.kind === "road"
  ? `${ROAD_LABEL[rec.data.type]} · ${entry.properties.name}${rec.data.widthM != null ? ` · 폭 ${rec.data.widthM}m` : ""}`
  : rec.kind === "light" ? `${entry.type} ${entry.count ?? "?"}개${entry.location ? " · " + entry.location : ""}` : entry.name;
const md = [`# 조사 기록 검토 (${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })})`, "",
  `새로 받은 기록 ${report.length}개 · 중복 후보 ${report.filter(r => r.near.length).length}개 · 이미 합친 기록 ${Object.keys(applied).length}개는 제외`, "",
  "| 결정 | 분류 | 조사일 | 조사자 | 내용 | 좌표 | 사진 | 확인할 점 |", "|-|-|-|-|-|-|-|-|"];
for (const r of report) {
  const { rec } = r, p0 = rec.kind === "road" ? `${rec.coords.length}개 점` : `${rec.lat}, ${rec.lng} (${rec.coordSource === "gps" ? "GPS" : "지도"})`;
  md.push(`| ${decisions[rec.id]} | ${LABEL[rec.category]} | ${rec.surveyDate} | ${rec.surveyor} | ${summaryOf(rec, r.entry)}${rec.memo ? ` (메모: ${rec.memo})` : ""} | ${p0} | ${rec.photos?.length || 0} | ${r.warn.join(", ")} |`);
}
const dups = report.filter(r => r.near.length);
if (dups.length) {
  md.push("", "## 중복 후보 — decisions.json 에서 정해 주세요", "");
  for (const r of dups) {
    md.push(`### ${LABEL[r.rec.category]} · ${summaryOf(r.rec, r.entry)} (${r.rec.surveyor}, ${r.rec.surveyDate}) — \`${r.rec.id}\``);
    for (const n of r.near) md.push(`- ${n.m}m 거리: \`${n.id}\` ${n.label}${n.diff.length ? `\n  - 달라진 값: ${n.diff.join(" / ")}` : n.id.startsWith("inbox:") ? "" : "\n  - 값은 같음 → 보통 \"confirm:" + n.id + "\""}`);
    md.push("");
  }
}
fs.writeFileSync(path.join(INBOX, "검토.md"), md.join("\n") + "\n");
writeJson(decisionsFile, decisions);
console.log(`검토할 기록 ${report.length}개 (중복 후보 ${dups.length}개) → survey-inbox/검토.md`);
if (!APPLY) process.exit(0);

// ── 합치기 ───────────────────────────────────────
const asks = report.filter(r => decisions[r.rec.id] === "ask");
if (asks.length) { console.error(`아직 정하지 않은 중복 후보 ${asks.length}개가 있어 합치지 않았습니다. decisions.json 을 고쳐 주세요.`); process.exit(1); }

function nextId(kind, category) {
  let list, prefix, width;
  if (kind === "road") { list = roads.value.features.map(f => f.properties.id); prefix = "seg"; width = 3; }
  else if (kind === "light") { list = lights.value.map(l => l.id); prefix = "light"; width = 4; }
  else {
    list = places.value.filter(p => p.category === category).map(p => p.id);
    prefix = list[0]?.replace(/-\d+$/, "") || category; width = 3;
    list = places.value.map(p => p.id);
  }
  const nums = list.filter(id => id?.startsWith(prefix + "-")).map(id => parseInt(id.slice(prefix.length + 1), 10)).filter(n => n >= 0);
  return `${prefix}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(width, "0")}`;
}
function copyPhotos(r, id) {
  fs.mkdirSync(path.join(ROOT, "photos"), { recursive: true });
  return (r.rec.photos || []).map((rel, i) => {
    let name = `${id}-${i + 1}.jpg`, n = i + 1;
    while (fs.existsSync(path.join(ROOT, "photos", name))) name = `${id}-${++n}.jpg`;
    fs.copyFileSync(path.join(INBOX, r.dir, rel), path.join(ROOT, "photos", name));
    return `photos/${name}`;
  });
}
const findTarget = (kind, id) => kind === "road" ? roads.value.features.find(f => f.properties.id === id)
  : kind === "light" ? lights.value.find(l => l.id === id) : places.value.find(p => p.id === id);
const log = [];
for (const r of report) {
  const dec = decisions[r.rec.id], kind = r.rec.kind, e = r.entry;
  if (dec === "skip") { applied[r.rec.id] = { result: "skip" }; continue; }
  const [act, targetId] = dec.split(":");
  if (act === "new") {
    const id = nextId(kind, r.rec.category), photos = copyPhotos(r, id);
    if (kind === "road") { e.properties.id = id; if (photos.length) e.properties.photos = photos; roads.value.features.push(e); }
    else if (kind === "light") { e.id = id; lights.value.push(e); }
    else { e.id = id; if (photos.length) e.details.photos = photos; places.value.push(e); }
    log.push(`추가 ${id} ${LABEL[r.rec.category]}`); applied[r.rec.id] = { result: id };
    continue;
  }
  const t = findTarget(kind, targetId);
  if (!t) { console.error(`${r.rec.id}: 대상 ${targetId} 를 찾지 못해 건너뜀`); continue; }
  const photos = copyPhotos(r, targetId);
  if (act === "confirm") {
    if (kind === "road") t.properties.verification = e.properties.verification; else t.verification = e.verification;
    delete t.sample;
  } else if (act === "replace") {
    if (kind === "road") { const old = t.properties.photos; Object.assign(t, e); t.properties.id = targetId; if (old) t.properties.photos = old; }
    else { const old = t.details?.photos; for (const k of Object.keys(t)) delete t[k]; Object.assign(t, e, { id: targetId }); if (old && t.details) t.details.photos = old; }
  } else { console.error(`${r.rec.id}: 알 수 없는 결정 "${dec}"`); continue; }
  if (photos.length) {
    const holder = kind === "road" ? t.properties : kind === "place" ? t.details : null;
    if (holder) holder.photos = [...(holder.photos || []), ...photos];
  }
  log.push(`${act === "confirm" ? "재확인" : "교체"} ${targetId} ${LABEL[r.rec.category]}${photos.length ? ` (사진 ${photos.length}장 추가)` : ""}`);
  applied[r.rec.id] = { result: `${act}:${targetId}` };
}

saveData("places.js", places.header, `window.PLACES = [\n${places.value.map(line).join("\n")}\n];`);
saveData("roads.js", roads.header, `window.ROADS = { type:"FeatureCollection", features:[\n${roads.value.features.map(line).join("\n")}\n]};`);
saveData("streetlights.js", lights.header, `window.STREETLIGHTS = [\n${lights.value.map(line).join("\n")}\n];`);
writeJson(path.join(INBOX, "applied.json"), applied);
console.log(log.join("\n") || "바뀐 것 없음");
