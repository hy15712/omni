// ── 분류 정의 ─────────────────────────────────────
const CATEGORIES = {
  toilet:   { label:"화장실", short:"WC",  color:"#2459B3" },
  bench:    { label:"벤치",   short:"벤치", color:"#5C7F2E" },
  stairs:   { label:"계단",   short:"계단", color:"#7A4FA8" },
  aed:      { label:"AED",    short:"AED", color:"#C2185B" },
  hospital: { label:"병원",   short:"병원", color:"#B23A2E" },
  pharmacy: { label:"약국",   short:"약국", color:"#0F8577" },
  fire:     { label:"소방서", short:"119", color:"#D9480F" },
  police:   { label:"지구대", short:"112", color:"#1E3A5F" },
  trash:    { label:"쓰레기통", short:"휴지", color:"#8A6D3B" },
};
const VSTATUS = { field:"현장확인", agency:"기관확인", unverified:"확인불가" };
const DAYS = ["sun","mon","tue","wed","thu","fri","sat"];
const DAY_KO = { mon:"월", tue:"화", wed:"수", thu:"목", fri:"금", sat:"토", sun:"일" };
const REPORT_TYPES = ["폐쇄됨","철거됨","공사중","운영시간 다름","정보가 다름","기타"];

const state = { active:new Set(Object.keys(CATEGORIES)), openNow:false, showRoads:true, showLights:false };

// ── 지도 ─────────────────────────────────────────
const B = window.SURVEY_BOUNDS;
const bounds = L.latLngBounds([B.south, B.west], [B.north, B.east]);
const map = L.map("map", { maxBounds: bounds.pad(0.3), minZoom: 15, maxZoom: 19, zoomControl: true })
  .fitBounds(bounds);

// ── 배경지도 ────────────────────────────────────
// 1순위: 브이월드(국토교통부, 공공저작물 출처표시) — data/config.js 에 인증키가 있을 때
// 2순위: OpenFreeMap(OpenStreetMap 기반, 키 불필요) — 지명을 한글로 바꿔 표시
// 쓰지 않는 것: OSM 공식 타일(file:// 차단), CARTO(2026년 8월 말부터 키 없으면 워터마크)
const CFG = window.MAP_CONFIG || {};
function addOpenFreeMap() {
  const base = L.maplibreGL({
    style: "https://tiles.openfreemap.org/styles/liberty",
    attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
  }).addTo(map);
  const gl = base.getMaplibreMap();
  gl.once("styledata", () => {
    gl.getStyle().layers.forEach(layer => {
      if (layer.type !== "symbol" || !layer.layout || !layer.layout["text-field"]) return;
      // 영어 대신 한글 이름(name:ko → name) 표시
      gl.setLayoutProperty(layer.id, "text-field", ["coalesce", ["get", "name:ko"], ["get", "name"]]);
    });
    gl.getStyle().layers.filter(l => l.type === "fill-extrusion")
      .forEach(l => gl.setLayoutProperty(l.id, "visibility", "none"));
  });
}
if (CFG.VWORLD_KEY) {
  const ext = CFG.VWORLD_STYLE === "Satellite" ? "jpeg" : "png";
  const vworld = L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${CFG.VWORLD_KEY}/${CFG.VWORLD_STYLE || "Base"}/{z}/{y}/{x}.${ext}`, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.vworld.kr" target="_blank">브이월드(국토교통부)</a>',
  }).addTo(map);
  // 키가 등록되지 않은 주소라 타일이 하나도 안 오면 OpenFreeMap으로 바꿉니다.
  let loaded = false;
  vworld.on("tileload", () => { loaded = true; });
  vworld.once("tileerror", () => { if (!loaded) { vworld.remove(); addOpenFreeMap(); } });
} else {
  addOpenFreeMap();
}

// 조사 범위 테두리
L.rectangle(bounds, { color:"#1E2A32", weight:1.5, dashArray:"6 6", fill:false, interactive:false }).addTo(map);

// ── 운영시간 ─────────────────────────────────────
function seoulNow() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone:"Asia/Seoul", weekday:"short",
    hour:"2-digit", minute:"2-digit", hour12:false }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  const day = get("weekday").toLowerCase().slice(0,3);
  return { day, minutes: (parseInt(get("hour"),10) % 24) * 60 + parseInt(get("minute"),10) };
}
const toMin = s => { const [h,m] = s.split(":").map(Number); return h*60 + m; };

// 반환: true(운영중) | false(운영 안 함) | null(확인불가)
function isOpenNow(place) {
  if (hasActiveClosureReport(place)) return false;
  const h = place.hours;
  if (h === "24h") return true;
  if (!h) return null;
  const { day, minutes } = seoulNow();
  const prev = DAYS[(DAYS.indexOf(day) + 6) % 7];
  const inRange = ([s,e], m) => { const a = toMin(s), b = toMin(e);
    return b > a ? (m >= a && m < b) : (m >= a || m < b); };
  if ((h[day] || []).some(r => inRange(r, minutes))) return true;
  // 전날 밤에 시작해 자정을 넘는 시간대
  return (h[prev] || []).some(([s,e]) => toMin(e) <= toMin(s) && minutes < toMin(e));
}
function hoursText(h) {
  if (h === "24h") return "24시간";
  if (!h) return "확인불가";
  return ["mon","tue","wed","thu","fri","sat","sun"]
    .map(d => `${DAY_KO[d]} ${(h[d]||[]).length ? h[d].map(r => r.join("–")).join(", ") : "휴무"}`).join(" · ");
}

// ── 시민 제보 (프로토타입: 이 브라우저에만 저장) ──────
const REPORT_KEY = "walkmap.reports.v1";
function loadReports() { try { return JSON.parse(localStorage.getItem(REPORT_KEY)) || {}; } catch { return {}; } }
function saveReport(id, r) {
  const all = loadReports(); (all[id] ||= []).unshift(r);
  try { localStorage.setItem(REPORT_KEY, JSON.stringify(all)); } catch {}
}
// 검토 전 제보는 표시만 하고 원본 정보는 바꾸지 않습니다.
// 관리자 승인 로직이 생기면 approved:true 인 '폐쇄됨/철거됨'만 상태에 반영합니다.
function hasActiveClosureReport(place) {
  return (loadReports()[place.id] || []).some(r => r.approved && ["폐쇄됨","철거됨"].includes(r.type));
}

// ── 필터 UI ──────────────────────────────────────
const filtersEl = document.getElementById("filters");
// 전체 선택/해제 칩: 시설 분류를 한 번에 켜고 끔(가로등은 따로)
const allChip = document.createElement("button");
allChip.className = "chip all";
filtersEl.appendChild(allChip);
const catChips = {};
function syncAllChip() {
  const all = state.active.size === Object.keys(CATEGORIES).length;
  allChip.textContent = all ? "전체 해제" : "전체 선택";
  allChip.setAttribute("aria-pressed", all);
  Object.entries(catChips).forEach(([k, b]) => b.setAttribute("aria-pressed", state.active.has(k)));
}
allChip.onclick = () => {
  const all = state.active.size === Object.keys(CATEGORIES).length;
  state.active = new Set(all ? [] : Object.keys(CATEGORIES));
  syncAllChip(); render();
};
Object.entries(CATEGORIES).forEach(([key, c]) => {
  const b = document.createElement("button");
  b.className = "chip"; b.style.setProperty("--c", c.color);
  b.setAttribute("aria-pressed", "true");
  b.innerHTML = `<span class="dot"></span>${c.label}`;
  b.onclick = () => {
    state.active.has(key) ? state.active.delete(key) : state.active.add(key);
    syncAllChip(); render();
  };
  catChips[key] = b;
  filtersEl.appendChild(b);
});
syncAllChip();
// 가로등 칩: 다른 분류와 달리 핀이 아니라 격자로 표시(기본 꺼짐)
const lightChip = document.createElement("button");
lightChip.className = "chip light"; lightChip.setAttribute("aria-pressed", "false");
lightChip.innerHTML = `<span class="dot"></span>가로등`;
lightChip.onclick = () => { state.showLights = !state.showLights;
  lightChip.setAttribute("aria-pressed", state.showLights); toggleLights(); };
filtersEl.appendChild(lightChip);

document.getElementById("openNow").onchange = e => { state.openNow = e.target.checked; render(); };
document.getElementById("showRoads").onchange = e => {
  state.showRoads = e.target.checked; state.showRoads ? roadLayer.addTo(map) : roadLayer.remove(); };
const aboutBtn = document.getElementById("aboutBtn"), about = document.getElementById("about");
// 상단 안내문구 접기: 처음엔 펼쳐서 보여 주고, 접으면 그 기기에 기억(지도 화면을 넓히려는 조원 피드백)
const PRINCIPLE_KEY = "walkmap.principleHidden";
const principle = document.getElementById("principle"), principleShow = document.getElementById("principleShow");
function setPrinciple(hidden, remember = true) {
  principle.hidden = hidden; principleShow.hidden = !hidden;
  if (remember) try { localStorage.setItem(PRINCIPLE_KEY, hidden ? "1" : ""); } catch {}
  window.dispatchEvent(new Event("resize"));   // 지도·조사 입력판 크기 다시 맞춤
}
document.getElementById("principleHide").onclick = () => setPrinciple(true);
principleShow.onclick = () => setPrinciple(false);
try { if (localStorage.getItem(PRINCIPLE_KEY) === "1") setPrinciple(true, false); } catch {}
// 필터 줄(분류 칩·토글) 접기: 지도를 최대한 넓게 보려는 조원 피드백. 접은 상태도 기기에 기억
const FILTER_KEY = "walkmap.filtersHidden";
const filterBox = document.getElementById("filterBox"), filterToggle = document.getElementById("filterToggle");
function setFilters(hidden, remember = true) {
  filterBox.hidden = hidden;
  filterToggle.textContent = hidden ? "필터 ▾" : "필터 ▴";
  filterToggle.setAttribute("aria-expanded", !hidden);
  if (remember) try { localStorage.setItem(FILTER_KEY, hidden ? "1" : ""); } catch {}
  window.dispatchEvent(new Event("resize"));
}
filterToggle.onclick = () => setFilters(!filterBox.hidden);
try { if (localStorage.getItem(FILTER_KEY) === "1") setFilters(true, false); } catch {}
aboutBtn.onclick = () => { about.hidden = !about.hidden; aboutBtn.setAttribute("aria-expanded", !about.hidden); };

// ── 보행 구간 ────────────────────────────────────
// 보행자 기준 표시: 차가 다닐 수 있는 길(차도·보차혼용)은 연한 붉은 선, 측정한 유효 폭이 NARROW_M 미만이면
// 형광 노랑 선(좁은 길, 검은 테두리), 인도는 초록. 선은 가늘게 그리고, 누르는 범위는 투명한 굵은 선으로 넓게 둡니다.
const NARROW_M = 1.5;
const NARROW_BASIS = "기준: 국토교통부 「보도 설치 및 관리 지침」(2018. 7. 26. 전면 개정) — 가로수 등을 제외한 보행자 통행 유효 폭 최소 1.5m, 휠체어·유모차가 교행할 수 있는 최소 폭";
const LINE_STYLE = {
  sidewalk: { color:"#1F8A5B", weight:1.7, opacity:.8 },
  car:      { color:"#D7263D", weight:1.7, opacity:.6 },
  narrow:   { color:"#E8FF00", weight:3.5, opacity:.65 },   // 형광 노랑(아래에 어두운 테두리 선을 깔아 밝은 배경에서도 보이게)
};
const lineKind = r => r.widthM != null && r.widthM < NARROW_M ? "narrow" : r.type === "sidewalk" ? "sidewalk" : "car";
const ROAD_LABEL = { sidewalk:"인도", shared:"보차혼용", roadway:"차도" };
const roadLayer = L.layerGroup([
  L.geoJSON(window.ROADS, { interactive:false, filter: f => lineKind(f.properties) === "narrow",
    style: { color:"#2B2B2B", weight:6, opacity:.55 } }),   // 좁은 길 테두리
  L.geoJSON(window.ROADS, { interactive:false, style: f => LINE_STYLE[lineKind(f.properties)] }),
  L.geoJSON(window.ROADS, {
    bubblingMouseEvents: false,
    style: { weight:18, opacity:0 },
    onEachFeature: (f, layer) => {
      layer.on("click", e => { L.DomEvent.stopPropagation(e); openRoad(f.properties); });
      // 폭을 잰 구간은 18레벨 이상 확대하면 선 위에 폭이 보임
      if (f.properties.widthM != null) layer.bindTooltip(`폭 ${f.properties.widthM}m`, { permanent:true, direction:"center",
        className:`width-tag${lineKind(f.properties) === "narrow" ? " narrow" : ""}` });
    },
  }),
]).addTo(map);
const syncWidthTags = () => document.getElementById("map").classList.toggle("show-width", map.getZoom() >= 18);
map.on("zoomend", syncWidthTags); syncWidthTags();

// ── 마커 ─────────────────────────────────────────
const markerLayer = L.layerGroup().addTo(map);
function pinIcon(place, open) {
  const c = CATEGORIES[place.category];
  const cls = ["pin", place.verification.status === "unverified" ? "unverified" : "", open === false ? "closed" : ""].join(" ");
  return L.divIcon({ className:"", iconSize:[22,22], iconAnchor:[11,22],
    html:`<div class="${cls}" style="--c:${c.color}"><b>${c.short}</b></div>` });
}
// ‘지금 운영 중’ 필터를 거는 분류. AED·벤치·계단·쓰레기통 등은 필터를 켜도 그대로 보입니다.
const OPEN_FILTER_CATS = ["hospital", "pharmacy", "toilet"];
function render() {
  markerLayer.clearLayers();
  let shown = 0, hiddenUnknown = 0;
  window.PLACES.forEach(p => {
    if (!state.active.has(p.category)) return;
    const open = isOpenNow(p);
    if (state.openNow && OPEN_FILTER_CATS.includes(p.category) && open !== true) { if (open === null) hiddenUnknown++; return; }
    shown++;
    L.marker([p.lat, p.lng], { icon: pinIcon(p, open), title: p.name, keyboard:true })
      .on("click", () => openPlace(p)).addTo(markerLayer);
  });
  document.getElementById("count").textContent =
    `${shown}곳 표시` + (hiddenUnknown ? ` · 운영시간 확인불가 ${hiddenUnknown}곳 제외` : "");
}

// ── 정보창 ───────────────────────────────────────
const sheet = document.getElementById("sheet"), sheetBody = document.getElementById("sheetBody");
document.getElementById("sheetClose").onclick = closeSheet;
map.on("click", closeSheet);
function closeSheet() { sheet.setAttribute("aria-hidden", "true"); if (typeof clearSelectedCell === "function") clearSelectedCell(); }
function showSheet(html) { sheetBody.innerHTML = html; sheet.setAttribute("aria-hidden", "false"); sheet.scrollTop = 0; }
const esc = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[ch]));
const yn = v => v === true ? "있음" : v === false ? "없음" : "확인불가";

function verificationRow(v) {
  return `<div class="vrow"><span class="vbadge ${v.status}">${VSTATUS[v.status]}</span>
    최종확인 ${esc(v.date)}${v.by ? ` · ${esc(v.by)}` : ""}</div>`;
}

// 칸이 아예 없으면(조사 때 ‘–’ 입력 안 함) 그 줄을 보이지 않고, null(‘모름’)이면 ‘확인불가’로 보입니다.
function detailRows(p) {
  const d = p.details, rows = [];
  const add = (k, v) => rows.push(`<dt>${k}</dt><dd>${v}</dd>`);
  const has = v => v !== undefined;
  const text = (k, v) => { if (v) add(k, esc(v)); };
  const num = (k, v, unit) => { if (has(v)) add(k, v != null ? `${v}${unit}` : "확인불가"); };
  switch (p.category) {
    case "toilet": {
      text("위치", d.location);
      if (has(d.accessibleStall)) add("장애인화장실", yn(d.accessibleStall));
      if (has(d.open)) add("개방 여부", d.open === true ? "개방" : d.open === false ? "비개방" : "확인불가");
      const ap = d.approach || {};
      const parts = [["단차", ap.step], ["계단", ap.stairs], ["경사로", ap.ramp]].filter(([, v]) => has(v));
      if (parts.length) add("접근경로", parts.map(([k, v]) => `${k} ${yn(v)}`).join(" · "));
      break;
    }
    case "stairs":
      num("칸수", d.steps, "칸"); text("위치", d.location);
      if (has(d.handrail)) add("손잡이", d.handrail ? esc(d.handrail) : "확인불가");
      text("대체 경로", d.altRoute);
      break;
    case "bench": num("개수", d.count, "개"); text("위치", d.location); break;
    case "aed": text("설치 위치", d.location); break;
    case "trash": text("위치", d.location); if (has(d.recycling)) add("분리배출", yn(d.recycling)); break;
    default:
      if (d.dept) add("진료과", esc(d.dept));
      if (d.phone) add("전화", `<a href="tel:${esc(d.phone)}">${esc(d.phone)}</a>`);
  }
  if (has(p.hours) && (p.hours !== null || ["toilet","aed","hospital","pharmacy"].includes(p.category))) add("운영시간", hoursText(p.hours));
  text("현장 메모", d.note);
  return rows.join("");
}

function openPlace(p) {
  const c = CATEGORIES[p.category], open = isOpenNow(p);
  const statusHtml = open === true ? `<span class="status open">지금 운영 중</span>`
    : open === false ? `<span class="status shut">지금 운영 안 함</span>`
    : `<span class="status">운영 여부 확인불가</span>`;
  const reports = loadReports()[p.id] || [];
  const photo = photoGallery(p.details.photos || (p.details.photo ? [p.details.photo] : []), p.name);
  showSheet(`
    <div class="cat" style="--c:${c.color}">${c.label}</div>
    <h2 id="sheetTitle">${esc(p.name)}</h2>
    ${verificationRow(p.verification)}
    ${photo}
    <p style="margin:0 0 10px">${statusHtml}</p>
    <dl class="facts">${detailRows(p)}</dl>
    <div class="reports"><h3>시민 제보 ${reports.length ? `(${reports.length})` : ""}</h3>
      ${reports.length ? `<ul>${reports.map(r => `<li><b>${esc(r.type)}</b> ${esc(r.memo)}
        <div class="meta">${esc(r.date)} · ${r.approved ? "검토 완료" : "검토 전"}</div></li>`).join("")}</ul>`
        : `<p class="note">아직 제보가 없습니다. 현장 상황이 다르면 알려주세요.</p>`}
    </div>
    <form class="report-form" id="reportForm">
      <h3>현장 상황 알리기</h3>
      <div class="opts">${REPORT_TYPES.map((t,i) =>
        `<label class="opt"><input type="radio" name="type" value="${t}" ${i===0?"checked":""}>${t}</label>`).join("")}</div>
      <textarea name="memo" placeholder="예: 10월 2일 오후 3시, 입구에 '공사로 폐쇄' 안내문" aria-label="상세 내용"></textarea>
      <button class="btn" type="submit">제보 보내기</button>
      <p class="note">제보는 검토 후 반영되며, 그 전까지 원래 정보와 함께 '검토 전'으로 표시됩니다.</p>
    </form>`);
  bindGallery();
  document.getElementById("reportForm").onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target);
    saveReport(p.id, { type:f.get("type"), memo:f.get("memo").trim(),
      date:new Date().toLocaleString("ko-KR", { timeZone:"Asia/Seoul" }), approved:false });
    openPlace(p);
  };
}

// 위치 사진: 첫 장이 대표, 여러 장이면 아래 작은 사진을 눌러 바꿔 봄
function photoGallery(list, name) {
  if (!list.length) return "";
  return `<figure class="gallery"><img class="main" src="${esc(list[0])}" alt="${esc(name)} 위치 사진">
    ${list.length > 1 ? `<div class="thumbs">${list.map((src, i) => `<button type="button" data-src="${esc(src)}" aria-label="사진 ${i + 1}">
      <img src="${esc(src)}" alt=""></button>`).join("")}</div>` : ""}</figure>`;
}
function bindGallery() {
  sheetBody.querySelectorAll(".gallery .thumbs button").forEach(b =>
    b.onclick = () => { b.closest(".gallery").querySelector(".main").src = b.dataset.src; });
}

function openRoad(r) {
  showSheet(`
    <div class="cat" style="--c:${LINE_STYLE[lineKind(r)].color}">보행 구간 · ${ROAD_LABEL[r.type]}${lineKind(r) === "narrow" ? " · 좁은 길" : ""}</div>
    <h2 id="sheetTitle">${esc(r.name)}</h2>
    ${verificationRow(r.verification)}
    ${photoGallery(r.photos || [], r.name)}
    <dl class="facts">
      <dt>구분</dt><dd>${ROAD_LABEL[r.type]}</dd>
      ${r.widthM !== undefined ? `<dt>유효 폭</dt><dd>${r.widthM != null ? r.widthM + "m" : "확인불가"}</dd>` : ""}
      ${r.surface !== undefined ? `<dt>포장</dt><dd>${esc(r.surface) || "확인불가"}</dd>` : ""}
      ${r.curbCut !== undefined ? `<dt>연석 경사로</dt><dd>${yn(r.curbCut)}</dd>` : ""}
      ${r.slopeNote !== undefined ? `<dt>경사</dt><dd>${esc(r.slopeNote) || "확인불가"}</dd>` : ""}
      ${r.note ? `<dt>현장 메모</dt><dd>${esc(r.note)}</dd>` : ""}
    </dl>
    ${lineKind(r) === "narrow" ? `<p class="note">형광 노랑 선(좁은 길): 측정한 유효 폭이 ${NARROW_M}m 미만인 구간입니다. ${NARROW_BASIS}.</p>` : ""}
    <p class="note">측정된 환경 정보만 표시합니다. 이 구간의 안전 여부는 평가하지 않습니다.</p>`);
  bindGallery();
}

// ── 가로등 격자 ──────────────────────────────────
// 조사 범위를 약 GRID_M 미터 칸으로 나누고, 칸마다 등 개수를 더해 색을 칠합니다.
const GRID_M = 25;
const dLat = GRID_M / 111320;
const dLng = GRID_M / (111320 * Math.cos((B.south + B.north) / 2 * Math.PI / 180));
// 개수 구간별 어둡기: 적을수록 어둡게(밤 표현), 많을수록 덜 어둡게 + 노란빛
const LIGHT_STEPS = [ // [최소 개수, 어둠 불투명도, 빛 색, 빛 불투명도, 범례 라벨] — 단계마다 색을 달리해 구별이 쉽게
  [5, 0.00, "#FFF7B0", 0.80, "5+"],
  [3, 0.08, "#FFC400", 0.62, "3–4"],
  [2, 0.24, "#E07800", 0.50, "2"],
  [1, 0.42, "#8A4B00", 0.42, "1"],
  [0, 0.72, null,      0,    "0"],
];
const NIGHT = "#0A1020";
const stepOf = n => LIGHT_STEPS.find(([min]) => n >= min);

map.createPane("gridPane").style.zIndex = 350;  // 배경지도 위, 보행구간·핀 아래
map.getPane("gridPane").classList.add("night-pane");
map.createPane("selPane").style.zIndex = 360;
const gridLayer = L.layerGroup();
const lightPointLayer = L.layerGroup();
let selectedCell = null;

// 지도에 쓰는 가로등 = 보안등 공공데이터(기관확인) + 큰길가 현장 조사 가로등(현장확인). (2026-11 사용자 결정)
// 골목은 보안등 공공데이터만 씁니다. 현장 조사 가로등은 큰길 선(data/big-roads.js)에서 ROAD_BUF_M 안에 있고,
// 보안등과 FIELD_DUP_M 안에 겹치지 않는 것만 더합니다. (조사 기록은 data/streetlights-survey.js 에 그대로 남아 있음)
const ROAD_BUF_M = 15, FIELD_DUP_M = 10;
const ALL_LIGHTS = (() => {
  const pub = window.STREETLIGHTS || [];
  const kx = 111320 * Math.cos(B.south * Math.PI / 180), ky = 111320;
  const near = (a, b) => Math.hypot((a.lat - b.lat) * ky, (a.lng - b.lng) * kx) <= FIELD_DUP_M;
  const segDist = (p, a, b) => {   // 점 p 에서 선분 a–b 까지 거리(m). a, b 는 [경도, 위도]
    const px = p.lng * kx, py = p.lat * ky, ax = a[0] * kx, ay = a[1] * ky, dx = b[0] * kx - ax, dy = b[1] * ky - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const onBigRoad = p => (window.BIG_ROAD_LINES || []).some(({ line }) =>
    line.slice(1).some((b, i) => segDist(p, line[i], b) <= ROAD_BUF_M));
  const field = (window.STREETLIGHTS_SURVEY || []).filter(s => onBigRoad(s) && !pub.some(p => near(s, p)));
  return pub.concat(field);
})();

function buildGrid() {
  const rows = Math.ceil((B.north - B.south) / dLat), cols = Math.ceil((B.east - B.west) / dLng);
  const cells = Array.from({ length: rows * cols }, () => ({ total: 0, items: [] }));
  ALL_LIGHTS.forEach(l => {
    const r = Math.floor((l.lat - B.south) / dLat), c = Math.floor((l.lng - B.west) / dLng);
    if (r < 0 || c < 0 || r >= rows || c >= cols) return;
    const cell = cells[r * cols + c]; cell.total += l.count || 1; cell.items.push(l);
  });
  const gridN = B.south + rows * dLat, gridE = B.west + cols * dLng;

  // 조사 범위 바깥은 자료가 없으므로 가장 어둡게 덮음 (구멍 뚫린 다각형)
  L.polygon([
    [[B.south - 1, B.west - 1], [gridN + 1, B.west - 1], [gridN + 1, gridE + 1], [B.south - 1, gridE + 1]],
    [[B.south, B.west], [gridN, B.west], [gridN, gridE], [B.south, gridE]],
  ], { pane: "gridPane", stroke: false, fillColor: NIGHT, fillOpacity: 0.78, interactive: false }).addTo(gridLayer);

  cells.forEach((cell, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const bounds = [[B.south + r * dLat, B.west + c * dLng], [B.south + (r + 1) * dLat, B.west + (c + 1) * dLng]];
    const [, dark, glowColor, glow] = stepOf(cell.total);
    L.rectangle(bounds, { pane: "gridPane", stroke: false, fillColor: NIGHT, fillOpacity: dark, interactive: false }).addTo(gridLayer);
    if (glow) L.rectangle(bounds, { pane: "gridPane", stroke: false, fillColor: glowColor, fillOpacity: glow, interactive: false }).addTo(gridLayer);
    // 클릭용 투명 칸 (흐림 효과 밖의 별도 층)
    L.rectangle(bounds, { pane: "selPane", stroke: false, fillOpacity: 0, bubblingMouseEvents: false })
      .on("click", e => { L.DomEvent.stopPropagation(e); selectCell(e.target); openCell(cell, r, c); })
      .addTo(gridLayer);
  });
  ALL_LIGHTS.forEach(l => {
    L.marker([l.lat, l.lng], { icon: L.divIcon({ className: "", iconSize: [9, 9],
      html: `<div class="light-dot ${l.type === "보안등" ? "sec" : ""}"></div>` }), title: `${l.type} ${l.count}개` })
      .on("click", () => openLight(l)).addTo(lightPointLayer);
  });
}

function selectCell(rect) {
  clearSelectedCell();
  selectedCell = rect; rect.setStyle({ stroke: true, weight: 2.5, color: "#FFFFFF", dashArray: "4 3" });
}
function clearSelectedCell() { if (selectedCell) selectedCell.setStyle({ stroke: false }); selectedCell = null; }

// 개별 등 위치는 충분히 확대했을 때만 표시(겹침 방지)
// 개별 등 위치를 보여 주기 시작하는 확대 단계(조원 피드백으로 18 → 17)
const LIGHT_POINT_ZOOM = 17;
function syncLightPoints() {
  const show = state.showLights && map.getZoom() >= LIGHT_POINT_ZOOM;
  show ? lightPointLayer.addTo(map) : lightPointLayer.remove();
}
function toggleLights() {
  document.body.classList.toggle("night", state.showLights);
  if (state.showLights) { gridLayer.addTo(map); document.getElementById("gridLegend").hidden = false; }
  else { gridLayer.remove(); document.getElementById("gridLegend").hidden = true; closeSheet(); }
  syncLightPoints();
}
map.on("zoomend", syncLightPoints);

// 지금 가로등 격자에 들어 있는 자료의 범위(‘0개’가 등이 없다는 뜻으로 읽히지 않게 정보창에 함께 안내)
const LIGHT_DATA_NOTE = "골목은 종로구·중구 보안등 공공데이터, 큰길가(종로·청계천로·을지로·삼일대로 등)는 조사팀이 현장에서 기록한 가로등입니다. 큰길 가로등 공식 자료는 아직 없어 빠진 등이 있을 수 있습니다.";
function openCell(cell, r, c) {
  const byType = cell.items.reduce((o, l) => (o[l.type] = (o[l.type] || 0) + (l.count || 1), o), {});
  const byStatus = cell.items.reduce((o, l) => (o[l.verification.status] = (o[l.verification.status] || 0) + 1, o), {});
  const dates = cell.items.map(l => l.verification.date).sort();
  const pct = n => cell.total ? (n / cell.total * 100) : 0;
  showSheet(`
    <div class="cat" style="--c:#B37400">가로등 · 격자 ${r + 1}-${c + 1}</div>
    <h2 id="sheetTitle">이 구역 가로등 ${cell.total}개</h2>
    <div class="vrow">약 ${GRID_M}m × ${GRID_M}m 칸 기준${dates.length ? ` · 자료 기준일 ${esc(dates[0])}${dates[0] !== dates.at(-1) ? `~${esc(dates.at(-1))}` : ""}` : ""}</div>
    ${cell.total ? `<div class="bar" aria-hidden="true">
        <span style="width:${pct(byType["가로등"] || 0)}%;background:#E89B00"></span>
        <span style="width:${pct(byType["보안등"] || 0)}%;background:#FFD23F"></span></div>` : ""}
    <dl class="facts">
      <dt>가로등</dt><dd>${byType["가로등"] || 0}개</dd>
      <dt>보안등</dt><dd>${byType["보안등"] || 0}개</dd>
      ${byType["미상"] ? `<dt>종류 미상</dt><dd>${byType["미상"]}개</dd>` : ""}
      <dt>설치 지점</dt><dd>${cell.items.length}곳</dd>
      <dt>확인 방법</dt><dd>${Object.entries(byStatus).map(([k, v]) => `${VSTATUS[k]} ${v}곳`).join(" · ") || "자료 없음"}</dd>
      ${cell.items.length ? `<dt>출처</dt><dd>${[...new Set(cell.items.map(l => l.verification.status === "field" ? `현장 조사 (${l.verification.by})` : l.verification.by).filter(Boolean))].map(esc).join("<br>")}</dd>` : ""}
    </dl>
    <p class="note">${cell.total ? "조금 더 확대하면 등 하나하나의 위치가 점으로 표시됩니다." : "지금 자료에는 이 칸에 등록된 등이 없습니다."}<br>
    ${LIGHT_DATA_NOTE}<br>설치 개수이며, 실제 조도(밝기)를 측정한 값이 아닙니다.</p>`);
}
function openLight(l) {
  showSheet(`
    <div class="cat" style="--c:#B37400">${esc(l.type)}</div>
    <h2 id="sheetTitle">${esc(l.type)} ${l.count != null ? `${l.count}개` : "(개수 확인불가)"}</h2>
    ${verificationRow(l.verification)}
    <dl class="facts"><dt>위치</dt><dd>${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}</dd>
      ${l.location ? `<dt>위치 설명</dt><dd>${esc(l.location)}</dd>` : ""}${l.mount ? `<dt>설치 형태</dt><dd>${esc(l.mount)}</dd>` : ""}${l.note ? `<dt>현장 메모</dt><dd>${esc(l.note)}</dd>` : ""}</dl>
    <p class="note">설치 개수이며, 실제 조도(밝기)를 측정한 값이 아닙니다.</p>`);
}
buildGrid();

render();
setInterval(render, 60 * 1000); // 1분마다 '지금 운영 중' 재계산
