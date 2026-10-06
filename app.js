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

const state = { active:new Set(Object.keys(CATEGORIES)), openNow:false, showRoads:true };

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
if (CFG.VWORLD_KEY) {
  const ext = CFG.VWORLD_STYLE === "Satellite" ? "jpeg" : "png";
  L.tileLayer(`https://api.vworld.kr/req/wmts/1.0.0/${CFG.VWORLD_KEY}/${CFG.VWORLD_STYLE || "Base"}/{z}/{y}/{x}.${ext}`, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.vworld.kr" target="_blank">브이월드(국토교통부)</a>',
  }).addTo(map);
} else {
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
Object.entries(CATEGORIES).forEach(([key, c]) => {
  const b = document.createElement("button");
  b.className = "chip"; b.style.setProperty("--c", c.color);
  b.setAttribute("aria-pressed", "true");
  b.innerHTML = `<span class="dot"></span>${c.label}`;
  b.onclick = () => {
    state.active.has(key) ? state.active.delete(key) : state.active.add(key);
    b.setAttribute("aria-pressed", state.active.has(key)); render();
  };
  filtersEl.appendChild(b);
});
document.getElementById("openNow").onchange = e => { state.openNow = e.target.checked; render(); };
document.getElementById("showRoads").onchange = e => {
  state.showRoads = e.target.checked; state.showRoads ? roadLayer.addTo(map) : roadLayer.remove(); };
const aboutBtn = document.getElementById("aboutBtn"), about = document.getElementById("about");
aboutBtn.onclick = () => { about.hidden = !about.hidden; aboutBtn.setAttribute("aria-expanded", !about.hidden); };

// ── 보행 구간 ────────────────────────────────────
const ROAD_STYLE = {
  sidewalk:{ color:"#1F8A5B", weight:6 },
  shared:  { color:"#C98A10", weight:6, dashArray:"8 6" },
  roadway: { color:"#7C8790", weight:5 },
};
const ROAD_LABEL = { sidewalk:"인도", shared:"보차혼용", roadway:"차도" };
const roadLayer = L.geoJSON(window.ROADS, {
  style: f => ({ ...ROAD_STYLE[f.properties.type], opacity:.85 }),
  onEachFeature: (f, layer) => layer.on("click", () => openRoad(f.properties)),
}).addTo(map);

// ── 마커 ─────────────────────────────────────────
const markerLayer = L.layerGroup().addTo(map);
function pinIcon(place, open) {
  const c = CATEGORIES[place.category];
  const cls = ["pin", place.verification.status === "unverified" ? "unverified" : "", open === false ? "closed" : ""].join(" ");
  return L.divIcon({ className:"", iconSize:[30,30], iconAnchor:[15,30],
    html:`<div class="${cls}" style="--c:${c.color}"><b>${c.short}</b></div>` });
}
function render() {
  markerLayer.clearLayers();
  let shown = 0, hiddenUnknown = 0;
  window.PLACES.forEach(p => {
    if (!state.active.has(p.category)) return;
    const open = isOpenNow(p);
    if (state.openNow && open !== true) { if (open === null) hiddenUnknown++; return; }
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
function closeSheet() { sheet.setAttribute("aria-hidden", "true"); }
function showSheet(html) { sheetBody.innerHTML = html; sheet.setAttribute("aria-hidden", "false"); sheet.scrollTop = 0; }
const esc = s => String(s ?? "").replace(/[&<>"]/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[ch]));
const yn = v => v === true ? "있음" : v === false ? "없음" : "확인불가";

function verificationRow(v) {
  return `<div class="vrow"><span class="vbadge ${v.status}">${VSTATUS[v.status]}</span>
    최종확인 ${esc(v.date)}${v.by ? ` · ${esc(v.by)}` : ""}</div>`;
}

function detailRows(p) {
  const d = p.details, rows = [];
  const add = (k, v) => rows.push(`<dt>${k}</dt><dd>${v}</dd>`);
  switch (p.category) {
    case "toilet":
      add("위치", esc(d.location)); add("장애인화장실", yn(d.accessibleStall));
      add("개방 여부", d.open === true ? "개방" : d.open === false ? "비개방" : "확인불가");
      add("접근경로", `단차 ${yn(d.approach?.step)} · 계단 ${yn(d.approach?.stairs)} · 경사로 ${yn(d.approach?.ramp)}`);
      break;
    case "stairs":
      add("칸수", d.steps != null ? `${d.steps}칸` : "확인불가"); add("위치", esc(d.location));
      if (d.handrail) add("손잡이", esc(d.handrail)); if (d.altRoute) add("대체 경로", esc(d.altRoute));
      break;
    case "bench": add("개수", d.count != null ? `${d.count}개` : "확인불가"); add("위치", esc(d.location)); break;
    case "aed": add("설치 위치", esc(d.location)); break;
    case "trash": add("위치", esc(d.location)); add("분리배출", yn(d.recycling)); break;
    default:
      if (d.dept) add("진료과", esc(d.dept));
      if (d.phone) add("전화", `<a href="tel:${esc(d.phone)}">${esc(d.phone)}</a>`);
  }
  if (p.hours !== null || ["toilet","aed","hospital","pharmacy"].includes(p.category)) add("운영시간", hoursText(p.hours));
  return rows.join("");
}

function openPlace(p) {
  const c = CATEGORIES[p.category], open = isOpenNow(p);
  const statusHtml = open === true ? `<span class="status open">지금 운영 중</span>`
    : open === false ? `<span class="status shut">지금 운영 안 함</span>`
    : `<span class="status">운영 여부 확인불가</span>`;
  const reports = loadReports()[p.id] || [];
  const photo = p.details.photo ? `<img src="${esc(p.details.photo)}" alt="${esc(p.name)} 위치 사진" style="width:100%;border-radius:8px;margin-bottom:10px">` : "";
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
  document.getElementById("reportForm").onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target);
    saveReport(p.id, { type:f.get("type"), memo:f.get("memo").trim(),
      date:new Date().toLocaleString("ko-KR", { timeZone:"Asia/Seoul" }), approved:false });
    openPlace(p);
  };
}

function openRoad(r) {
  showSheet(`
    <div class="cat" style="--c:${ROAD_STYLE[r.type].color}">보행 구간 · ${ROAD_LABEL[r.type]}</div>
    <h2 id="sheetTitle">${esc(r.name)}</h2>
    ${verificationRow(r.verification)}
    <dl class="facts">
      <dt>구분</dt><dd>${ROAD_LABEL[r.type]}</dd>
      <dt>유효 폭</dt><dd>${r.widthM != null ? r.widthM + "m" : "확인불가"}</dd>
      <dt>포장</dt><dd>${esc(r.surface) || "확인불가"}</dd>
      <dt>연석 경사로</dt><dd>${yn(r.curbCut)}</dd>
      <dt>경사</dt><dd>${esc(r.slopeNote) || "확인불가"}</dd>
    </dl>
    <p class="note">측정된 환경 정보만 표시합니다. 이 구간의 안전 여부는 평가하지 않습니다.</p>`);
}

render();
setInterval(render, 60 * 1000); // 1분마다 '지금 운영 중' 재계산
