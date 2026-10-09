// ── 조사 입력 모드 ─────────────────────────────────
// 주소 뒤에 ?survey=1 을 붙였을 때만 켜집니다. 일반 이용자 화면에는 아무 영향이 없습니다.
// 기록은 이 기기(브라우저 IndexedDB)에만 저장되고 공개 지도에는 나오지 않습니다.
// [내보내기]로 만든 zip을 검토한 뒤 scripts/merge-survey.mjs 로 data/*.js 에 합칩니다.
// app.js 의 map, CATEGORIES, bounds, esc, hoursText, DAY_KO 를 그대로 씁니다.
(() => {
if (new URLSearchParams(location.search).get("survey") !== "1") return;

const NAME_KEY = "walkmap.surveyor", DATE_KEY = "walkmap.surveyDate";
const GPS_WARN_M = 15;          // 정확도가 이보다 나쁘면 핀 위치 확인 안내
const GPS_GOOD_M = 10, GPS_WAIT_MS = 10000;
const PHOTO_MAX = 1600, PHOTO_Q = 0.82;
const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
const WEEK = ["mon","tue","wed","thu","fri","sat","sun"];

const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone:"Asia/Seoul" }).format(new Date());
const store = s => ({ get: k => { try { return s().getItem(k); } catch { return null; } },
  set: (k, v) => { try { s().setItem(k, v); } catch {} } });
const local = store(() => localStorage), session = store(() => sessionStorage);
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const newId = () => "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
const round6 = n => Math.round(n * 1e6) / 1e6;

// ── 분류와 입력 칸 ────────────────────────────────
const SCATS = {
  ...Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, { ...c, kind:"place" }])),
  streetlight: { label:"가로등", short:"등", color:"#B37400", kind:"light" },
  road:        { label:"보행 구간(선)", short:"선", color:"#1F8A5B", kind:"road" },
};
// 접근 경로가 보이는 위치 사진을 지도에 붙이는 분류 → 사진 칸을 맨 위에 크게
const PHOTO_FIRST = ["toilet", "aed"];

// [종류, 키, 이름, 추가값] — tri: 있음/없음/모름, choice: 고르기(+모름), count: −/+ 숫자
const NAME_ONLY = [["text","name","이름","간판에 적힌 이름"]];
const FIELDS = {
  toilet: [
    ["text","location","위치 설명","예: 공원 동문 안쪽 왼편"],
    ["tri","accessibleStall","장애인화장실"],
    ["tri","open","개방 여부",["개방","비개방","모름"]],
    ["hours","hours","개방시간"],
    ["head","접근경로"],
    ["tri","approach.step","단차"],
    ["tri","approach.stairs","계단"],
    ["tri","approach.ramp","경사로"],
  ],
  stairs: [
    ["count","steps","칸수"],
    ["text","location","위치 설명","예: 출입구에서 지하 대합실까지"],
    ["choice","handrail","손잡이",["양쪽","한쪽","없음"]],
    ["text","altRoute","대체 경로","예: 20m 옆 엘리베이터"],
  ],
  bench: [["count","count","개수"], ["text","location","위치 설명","예: 공원 서쪽 산책로"]],
  aed: [["text","location","설치 위치","예: 건물 1층 로비 안내데스크 옆"], ["hours","hours","이용 가능 시간 (건물 개방시간)"]],
  trash: [["text","location","위치 설명","예: 버스정류장 옆"], ["tri","recycling","분리배출 칸"]],
  hospital: NAME_ONLY, pharmacy: NAME_ONLY, fire: NAME_ONLY, police: NAME_ONLY,
  streetlight: [
    ["count","count","개수 (쌍등이면 2)",1],
    ["choice","type","종류",["가로등","보안등"]],
    ["text","location","위치 설명","예: 골목 입구 전봇대"],
  ],
  road: [
    ["choice","type","구분",[["sidewalk","인도"],["roadway","차도"],["shared","보차혼용 (인도 없음)"]],"required"],
    ["text","name","구간 이름","예: 인사동길 남쪽 골목"],
    ["decimal","widthM","유효 폭 (m)","예: 2.5"],
    ["choice","surface","포장",["보도블록","아스팔트","콘크리트","기타"]],
    ["tri","curbCut","연석 경사로"],
    ["text","slopeNote","경사 메모","예: 완만한 오르막(북쪽 방향)"],
  ],
};
const TRI = ["있음","없음","모름"];
const optsOf = list => list.map(o => Array.isArray(o) ? o : [o, o]);

// ── 기기 안 저장소(IndexedDB) ──────────────────────
// 사진은 Safari 호환을 위해 Blob 대신 ArrayBuffer 로 저장합니다.
const DB = (() => {
  let opening;
  const open = () => opening ||= new Promise((res, rej) => {
    const r = indexedDB.open("walkmap-survey", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("records", { keyPath:"id" });
      r.result.createObjectStore("photos", { keyPath:"id" }).createIndex("recordId", "recordId");
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const os = async (name, mode = "readonly") => (await open()).transaction(name, mode).objectStore(name);
  return {
    all: async name => req((await os(name)).getAll()),
    put: async (name, v) => req((await os(name, "readwrite")).put(v)),
    del: async (name, k) => req((await os(name, "readwrite")).delete(k)),
    photosOf: async id => req((await os("photos")).index("recordId").getAll(id)),
  };
})();
navigator.storage?.persist?.().catch(() => {});

// ── 화면 뼈대 ────────────────────────────────────
document.body.classList.add("survey");
const header = $(".top");
header.insertAdjacentHTML("afterbegin", `
  <div class="sv-bar">
    <span class="tag">조사 모드</span>
    <span>조사자 <b id="svName"></b> <button type="button" id="svNameBtn" class="sv-link">변경</button></span>
    <label class="sv-date">조사일 <input type="date" id="svDate"></label>
    <span id="svDateWarn" class="warn" hidden>오늘이 아닌 날짜로 기록 중</span>
    <span class="sv-private">이 기록은 공개 지도에 바로 나오지 않습니다</span>
  </div>`);
document.body.insertAdjacentHTML("beforeend", `
  <section id="svPanel" class="sv-panel" aria-label="조사 입력">
    <div class="sv-head">
      <div class="sv-tabs" role="tablist">
        <button type="button" data-tab="new" class="on">새로 입력</button>
        <button type="button" data-tab="list">기록 목록 <span id="svCount"></span></button>
        <button type="button" data-tab="export">내보내기</button>
      </div>
      <button type="button" class="sv-fold" aria-label="입력판 접기" aria-expanded="true">▾</button>
    </div>
    <div class="sv-body">
      <div data-pane="new"></div><div data-pane="list" hidden></div><div data-pane="export" hidden></div>
    </div>
  </section>
  <div id="svToast" class="sv-toast" role="status" hidden></div>`);
const panel = $("#svPanel"), paneNew = $('[data-pane="new"]'), paneList = $('[data-pane="list"]'), paneExport = $('[data-pane="export"]');

let tab = "new";
function showTab(t) {
  tab = t;
  $$(".sv-tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  $$("[data-pane]", panel).forEach(p => p.hidden = p.dataset.pane !== t);
  setFolded(false);
  if (t === "list") renderList();
  if (t === "export") renderExport();
}
$$(".sv-tabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));
function setFolded(f) {
  panel.classList.toggle("folded", f);
  $(".sv-fold").textContent = f ? "▴" : "▾";
  $(".sv-fold").setAttribute("aria-expanded", !f);
  $(".sv-fold").setAttribute("aria-label", f ? "입력판 펼치기" : "입력판 접기");
}
$(".sv-fold").onclick = () => setFolded(!panel.classList.contains("folded"));

// 넓은 화면(아이패드 가로 등)은 오른쪽 고정, 좁은 화면은 아래에서 올라오는 판
const wideMq = matchMedia("(min-width: 900px)");
function layout() {
  document.body.classList.toggle("sv-wide", wideMq.matches);
  panel.style.top = wideMq.matches ? header.getBoundingClientRect().bottom + "px" : "";
  document.documentElement.style.setProperty("--sv-h", wideMq.matches ? "0px" : panel.offsetHeight + "px");
  map.invalidateSize();
}
window.addEventListener("resize", layout);
if (window.ResizeObserver) new ResizeObserver(layout).observe(panel);

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $("#svToast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
}

// ── 조사자 이름 · 조사일 ─────────────────────────
function surveyor() { return local.get(NAME_KEY) || ""; }
function askName(first) {
  document.body.insertAdjacentHTML("beforeend", `
    <div class="sv-modal" id="svNameModal"><form class="box">
      <h2>${first ? "조사 모드를 시작합니다" : "조사자 이름 변경"}</h2>
      <p class="note">이름은 이 기기에만 기억되고, 내보낸 기록과 지도의 ‘최종확인’ 옆에 표시됩니다. 별명이나 이니셜도 괜찮습니다.</p>
      <label class="sv-field"><span>조사자 이름</span><input type="text" name="n" required maxlength="20" value="${esc(surveyor())}" autocomplete="name"></label>
      <div class="sv-actions">${first ? "" : `<button type="button" class="btn2" data-cancel>취소</button>`}<button class="btn">확인</button></div>
    </form></div>`);
  const m = $("#svNameModal"), input = $("input", m);
  setTimeout(() => input.focus(), 50);
  $("[data-cancel]", m)?.addEventListener("click", () => m.remove());
  $("form", m).onsubmit = e => {
    e.preventDefault();
    const n = input.value.trim(); if (!n) return;
    local.set(NAME_KEY, n); $("#svName").textContent = n; m.remove();
  };
}
$("#svName").textContent = surveyor();
$("#svNameBtn").onclick = () => askName(false);
if (!surveyor()) askName(true);

const dateInput = $("#svDate");
dateInput.max = today();
dateInput.value = session.get(DATE_KEY) || today();
function syncDate() {
  if (!dateInput.value) dateInput.value = today();
  session.set(DATE_KEY, dateInput.value);
  $("#svDateWarn").hidden = dateInput.value === today();
}
dateInput.onchange = syncDate; syncDate();

// ── 입력 칸 만들기 · 읽기 · 채우기 ──────────────────
function fieldHtml([type, key, label, extra, flag]) {
  if (type === "head") return `<h4 class="sv-sub">${esc(key)}</h4>`;
  const name = `<span>${esc(label)}${flag === "required" ? ` <em class="req">필수</em>` : ""}</span>`;
  switch (type) {
    case "text": return `<label class="sv-field">${name}<input type="text" data-field="${key}" data-type="text" placeholder="${esc(extra || "")}"></label>`;
    case "decimal": return `<label class="sv-field">${name}<input type="text" inputmode="decimal" data-field="${key}" data-type="decimal" placeholder="${esc(extra || "")} · 모르면 비워 두기"></label>`;
    case "count": return `<div class="sv-field">${name}<div class="stepper" data-field="${key}" data-type="count" data-default="${extra ?? ""}">
        <button type="button" data-step="-1" aria-label="${esc(label)} 줄이기">−</button>
        <input type="number" inputmode="numeric" min="0" placeholder="모름" aria-label="${esc(label)}">
        <button type="button" data-step="1" aria-label="${esc(label)} 늘리기">+</button></div></div>`;
    case "tri": { const l = extra || TRI;
      return `<div class="sv-field">${name}<div class="seg" data-field="${key}" data-type="tri">
        <button type="button" data-v="true">${l[0]}</button><button type="button" data-v="false">${l[1]}</button><button type="button" data-v="null">${l[2]}</button></div></div>`; }
    case "choice": return `<div class="sv-field">${name}<div class="seg" data-field="${key}" data-type="choice"${flag === "required" ? " data-required" : ""}>
        ${optsOf(extra).map(([v, l]) => `<button type="button" data-v="${esc(v)}">${esc(l)}</button>`).join("")}
        ${flag === "required" ? "" : `<button type="button" data-v="">모름</button>`}</div></div>`;
    case "hours": return `<div class="sv-field">${name}<div class="hours" data-field="${key}" data-type="hours">
        <div class="seg hours-mode">
          <button type="button" data-mode="same">매일 같은 시간</button><button type="button" data-mode="days">요일별</button>
          <button type="button" data-mode="24h">24시간</button><button type="button" data-mode="unknown">모름</button></div>
        <div class="hours-same" hidden><input type="time" class="h-s" aria-label="시작"> ~ <input type="time" class="h-e" aria-label="끝"></div>
        <div class="hours-days" hidden>${WEEK.map(d => `<div class="hday" data-day="${d}"><b>${DAY_KO[d]}</b>
          <input type="time" class="h-s" aria-label="${DAY_KO[d]} 시작"> ~ <input type="time" class="h-e" aria-label="${DAY_KO[d]} 끝">
          <label class="off"><input type="checkbox" class="h-off"> 휴무</label></div>`).join("")}</div>
        <p class="note">자정을 넘기면 끝 시간을 다음 날 시각으로(예: 22:00 ~ 02:00). 24시까지면 00:00.</p></div></div>`;
  }
}
const segSet = (seg, v) => $$("button", seg).forEach(b => b.classList.toggle("on", (b.dataset.v ?? b.dataset.mode) === v));
const segGet = seg => { const b = $("button.on", seg); return b ? (b.dataset.v ?? b.dataset.mode) : undefined; };

function hoursMode(el, mode) {
  segSet($(".hours-mode", el), mode);
  $(".hours-same", el).hidden = mode !== "same";
  $(".hours-days", el).hidden = mode !== "days";
}
function readHours(el) {
  const mode = segGet($(".hours-mode", el));
  if (mode === "24h") return "24h";
  if (mode === "same") {
    const s = $(".hours-same .h-s", el).value, e = $(".hours-same .h-e", el).value;
    if (!s || !e) throw new Error("시간을 입력하거나 ‘모름’을 골라 주세요.");
    return Object.fromEntries(WEEK.map(d => [d, [[s, e]]]));
  }
  if (mode === "days") return Object.fromEntries(WEEK.map(d => {
    const row = $(`.hday[data-day="${d}"]`, el);
    if ($(".h-off", row).checked) return [d, []];
    const s = $(".h-s", row).value, e = $(".h-e", row).value;
    if (!s || !e) throw new Error(`${DAY_KO[d]}요일 시간을 입력하거나 ‘휴무’로 표시해 주세요.`);
    return [d, [[s, e]]];
  }));
  return null;
}
function fillHours(el, h) {
  if (h === "24h") return hoursMode(el, "24h");
  if (!h) return hoursMode(el, "unknown");
  const key = r => JSON.stringify(r || []);
  const allSame = WEEK.every(d => key(h[d]) === key(h.mon)) && (h.mon || []).length === 1;
  if (allSame) {
    hoursMode(el, "same");
    $(".hours-same .h-s", el).value = h.mon[0][0]; $(".hours-same .h-e", el).value = h.mon[0][1];
    return;
  }
  hoursMode(el, "days");
  WEEK.forEach(d => {
    const row = $(`.hday[data-day="${d}"]`, el), r = (h[d] || [])[0];
    $(".h-off", row).checked = !r;
    $(".h-s", row).value = r ? r[0] : ""; $(".h-e", row).value = r ? r[1] : "";
  });
}

function readFields(form) {
  const out = {};
  for (const el of $$("[data-field]", form)) {
    const k = el.dataset.field;
    let v;
    switch (el.dataset.type) {
      case "text": v = el.value.trim() || null; break;
      case "decimal": {
        const s = el.value.trim().replace(",", ".");
        v = s ? Number(s) : null;
        if (s && !(v >= 0)) throw new Error(`‘${el.closest(".sv-field").firstElementChild.textContent}’에는 숫자만 적어 주세요.`);
        break;
      }
      case "count": { const s = $("input", el).value; v = s === "" ? null : Math.max(0, parseInt(s, 10)); break; }
      case "tri": v = JSON.parse(segGet(el) ?? "null"); break;
      case "choice":
        v = segGet(el) || null;
        if (!v && el.hasAttribute("data-required")) throw new Error(`‘${el.closest(".sv-field").firstElementChild.textContent.replace("필수", "").trim()}’을(를) 골라 주세요.`);
        break;
      case "hours": v = readHours(el); break;
    }
    const path = k.split("."), last = path.pop();
    path.reduce((o, p) => o[p] ||= {}, out)[last] = v;
  }
  return out;
}
function fillFields(form, data = {}) {
  for (const el of $$("[data-field]", form)) {
    const v = el.dataset.field.split(".").reduce((o, p) => o?.[p], data);
    switch (el.dataset.type) {
      case "text": case "decimal": el.value = v ?? ""; break;
      case "count": $("input", el).value = v ?? el.dataset.default; break;
      case "tri": segSet(el, String(v ?? null)); break;
      case "choice": segSet(el, v ?? (el.hasAttribute("data-required") ? undefined : "")); break;
      case "hours": fillHours(el, v === undefined ? null : v); break;
    }
  }
}
// 버튼형 칸 공통 동작
paneNew.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const seg = b.closest(".seg");
  if (seg) {
    if (seg.classList.contains("hours-mode")) hoursMode(seg.closest(".hours"), b.dataset.mode);
    else segSet(seg, b.dataset.v);
    return;
  }
  if (b.dataset.step) {
    const input = $("input", b.closest(".stepper"));
    const n = (input.value === "" ? 0 : parseInt(input.value, 10)) + Number(b.dataset.step);
    input.value = n < 0 ? "" : n;   // 0 아래로 내리면 ‘모름’(빈칸)
  }
});

// ── 작성 중인 기록(draft)과 지도 ──────────────────
let draft = null;
const draftLayer = L.layerGroup().addTo(map);
const savedLayer = L.layerGroup().addTo(map);
const pinHtml = (cat, cls) => `<div class="pin ${cls}" style="--c:${SCATS[cat].color}"><b>${SCATS[cat].short}</b></div>`;
const pinIconOf = (cat, cls) => L.divIcon({ className:"", iconSize:[30,30], iconAnchor:[15,30], html: pinHtml(cat, cls) });

function startDraft(cat, rec = null) {
  stopGps();
  draftLayer.clearLayers();
  draft = cat && {
    cat, kind: SCATS[cat].kind, editing: rec, loc: null, pts: [],
    photos: [], removed: [], marker: null, accCircle: null, line: null,
  };
  renderForm();
  if (!draft) return;
  if (rec) {
    fillFields(paneNew, rec.data); $("#svMemo").value = rec.memo || "";
    if (draft.kind === "road") rec.coords.forEach(([lng, lat], i) => addPt(L.latLng(lat, lng), rec.pointSources?.[i] || rec.coordSource, null, false));
    else setLoc(L.latLng(rec.lat, rec.lng), rec.coordSource, rec.gpsAccuracy, false);
    DB.photosOf(rec.id).then(list => {
      const order = rec.photoIds || [];
      list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
        .forEach(p => draft?.editing === rec && draft.photos.push({ id: p.id, blob: new Blob([p.data], { type: p.type }) }));
      renderThumbs();
    });
  } else fillFields(paneNew);
}

function setLoc(latlng, src, acc, pan = true) {
  draft.loc = { lat: round6(latlng.lat), lng: round6(latlng.lng), src, acc: acc ?? null };
  if (!draft.marker) {
    draft.marker = L.marker(latlng, { icon: pinIconOf(draft.cat, "draft"), draggable: true, zIndexOffset: 1000, title: "끌어서 위치 조정" })
      .on("dragend", () => setLoc(draft.marker.getLatLng(), "map", null, false))
      .addTo(draftLayer);
  } else draft.marker.setLatLng(latlng);
  draftLayer.removeLayer(draft.accCircle || {}); draft.accCircle = null;
  if (acc) draft.accCircle = L.circle(latlng, { radius: acc, color: "#2459B3", weight: 1, fillOpacity: .08, interactive: false }).addTo(draftLayer);
  if (pan) map.panTo(latlng);
  renderCoord();
}
function addPt(latlng, src, acc, pan = true) {
  draft.pts.push({ lat: round6(latlng.lat), lng: round6(latlng.lng), src, acc: acc ?? null });
  drawLine(); if (pan) map.panTo(latlng);
}
function drawLine() {
  draftLayer.clearLayers();
  const ll = draft.pts.map(p => [p.lat, p.lng]);
  if (ll.length > 1) L.polyline(ll, { color: SCATS.road.color, weight: 6, dashArray: "8 6", interactive: false }).addTo(draftLayer);
  ll.forEach((p, i) => L.circleMarker(p, { radius: i === ll.length - 1 ? 8 : 6, color: "#fff", weight: 2,
    fillColor: SCATS.road.color, fillOpacity: 1, interactive: false }).addTo(draftLayer));
  renderCoord();
}

map.on("click", e => {
  if (!draft || tab !== "new") return;
  if (draft.kind === "road") addPt(e.latlng, "map", null, false);
  else setLoc(e.latlng, "map", null, false);
});

// ── 현재 위치(GPS) ───────────────────────────────
let watchId = null, gpsTimer = null;
function stopGps() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; clearTimeout(gpsTimer);
  const b = $('[data-act="gps"]', paneNew); if (b) { b.disabled = false; b.textContent = b.dataset.label; }
}
function startGps() {
  if (!window.isSecureContext || !navigator.geolocation) {
    toast("현재 위치(GPS)는 공개 사이트(https 주소)에서만 됩니다. 지도를 눌러 위치를 찍어 주세요.", 6000); return;
  }
  stopGps();
  const btn = $('[data-act="gps"]', paneNew); btn.disabled = true; btn.textContent = "위치 잡는 중…";
  const d = draft, t0 = Date.now();
  let best = null;
  const finish = () => {
    stopGps();
    if (draft !== d) return;
    if (!best) { toast("위치를 잡지 못했습니다. 지도를 눌러 찍어 주세요."); return; }
    if (d.kind === "road") addPt(L.latLng(best.lat, best.lng), "gps", best.acc);
    if (best.acc > GPS_WARN_M) toast(`정확도가 ±${best.acc}m 입니다. 핀이 맞는 자리에 있는지 확인하고, 아니면 끌어서 옮겨 주세요.`, 6000);
  };
  watchId = navigator.geolocation.watchPosition(p => {
    if (draft !== d) return stopGps();
    const acc = Math.round(p.coords.accuracy);
    if (!best || acc < best.acc) {
      best = { lat: p.coords.latitude, lng: p.coords.longitude, acc };
      if (d.kind !== "road") setLoc(L.latLng(best.lat, best.lng), "gps", acc);
      btn.textContent = `위치 잡는 중… ±${acc}m`;
    }
    if (best.acc <= GPS_GOOD_M || Date.now() - t0 > GPS_WAIT_MS) finish();
  }, err => {
    stopGps();
    toast(err.code === 1
      ? "위치 권한이 꺼져 있습니다. 아이패드 설정 > 개인정보 보호 > 위치 서비스 > Safari 웹 사이트를 ‘앱을 사용하는 동안’으로 바꿔 주세요."
      : "위치를 잡지 못했습니다. 지도를 눌러 찍어 주세요.", 7000);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  gpsTimer = setTimeout(finish, GPS_WAIT_MS + 2000);
}

// ── 사진 ─────────────────────────────────────────
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("사진을 읽지 못했습니다.")); i.src = url;
    });
    const s = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("사진을 줄이지 못했습니다.")), "image/jpeg", PHOTO_Q));
  } finally { URL.revokeObjectURL(url); }
}
async function addPhotos(files) {
  const d = draft;
  for (const f of files) {
    try { const blob = await shrink(f); if (draft === d) d.photos.push({ id: newId(), blob, fresh: true }); }
    catch (err) { toast(err.message); }
  }
  renderThumbs();
}
const thumbUrls = [];
function renderThumbs() {
  const box = $("#svThumbs"); if (!box || !draft) return;
  thumbUrls.splice(0).forEach(URL.revokeObjectURL);
  box.innerHTML = draft.photos.map((p, i) => {
    const u = URL.createObjectURL(p.blob); thumbUrls.push(u);
    return `<div class="sv-thumb"><img src="${u}" alt="사진 ${i + 1}">${i === 0 ? `<span class="badge">대표</span>` : ""}
      <div class="acts">${i ? `<button type="button" data-ph="first" data-i="${i}">대표로</button>` : ""}
      <button type="button" data-ph="del" data-i="${i}">삭제</button></div></div>`;
  }).join("");
}

// ── 새로 입력 화면 ───────────────────────────────
function catPicker() {
  return `<p class="sv-lead">무엇을 기록할까요?</p>
    <div class="sv-cats">${Object.entries(SCATS).map(([k, c]) =>
      `<button type="button" data-cat="${k}" style="--c:${c.color}"><span class="dot"></span>${esc(c.label)}</button>`).join("")}</div>
    <p class="note">측정하거나 눈으로 확인한 사실만 적어 주세요. ‘안전하다/위험하다’ 같은 평가는 적지 않습니다.
    모르는 칸은 ‘모름’으로 두면 지도에 ‘확인불가’로 표시됩니다.</p>`;
}
function photoBlock(big) {
  return `<div class="sv-photos ${big ? "big" : ""}">
    <h4 class="sv-sub">${big ? "위치 사진 <small>(접근 경로가 보이게 · 첫 사진이 지도에 대표로 나옵니다)</small>" : "사진 <small>(선택)</small>"}</h4>
    <div class="sv-photo-btns">
      <label class="btn2">📷 카메라로 찍기<input type="file" accept="image/*" capture="environment" multiple hidden></label>
      <label class="btn2">🖼 보관함에서 고르기<input type="file" accept="image/*" multiple hidden></label>
    </div>
    <div id="svThumbs" class="sv-thumbs"></div>
    <p class="note">사진은 공개 지도에 올라갑니다. 사람 얼굴·차 번호판이 나오지 않게 찍어 주세요.</p></div>`;
}
function renderForm() {
  if (!draft) { paneNew.innerHTML = catPicker(); return; }
  const c = SCATS[draft.cat], road = draft.kind === "road", big = PHOTO_FIRST.includes(draft.cat);
  paneNew.innerHTML = `
    <div class="sv-formhead" style="--c:${c.color}"><span class="dot"></span><b>${esc(c.label)}</b>
      ${draft.editing ? `<span class="sv-editing">수정 중 · 조사일 ${esc(draft.editing.surveyDate)} · ${esc(draft.editing.surveyor)}</span>` : ""}
      <button type="button" class="sv-link" data-act="change">분류 바꾸기</button></div>
    <div class="sv-loc">
      <button type="button" class="btn big" data-act="gps" data-label="${road ? "📍 현재 위치를 점으로 추가" : "📍 현재 위치"}">${road ? "📍 현재 위치를 점으로 추가" : "📍 현재 위치"}</button>
      <p class="hint">${road ? "또는 지도에서 선의 점을 차례로 누르세요." : "또는 지도를 눌러 위치를 찍으세요. 핀은 끌어서 옮길 수 있습니다."}</p>
      <div id="svCoord" class="sv-coord"></div>
      ${road ? `<div class="sv-row"><button type="button" class="btn2" data-act="undo">되돌리기</button><button type="button" class="btn2" data-act="clearpts">다시 그리기</button></div>` : ""}
    </div>
    ${big ? photoBlock(true) : ""}
    <form id="svForm" onsubmit="return false">
      ${FIELDS[draft.cat].map(fieldHtml).join("")}
      ${big ? "" : photoBlock(false)}
      <label class="sv-field"><span>메모 <small>(지도에는 나오지 않음)</small></span><textarea id="svMemo" rows="3" placeholder="예: 입구에 ‘공사로 폐쇄’ 안내문"></textarea></label>
    </form>
    <div class="sv-actions">
      ${draft.editing ? `<button type="button" class="btn2 danger" data-act="delete">삭제</button><button type="button" class="btn2" data-act="cancel">취소</button>` : ""}
      <button type="button" class="btn" data-act="save">${draft.editing ? "수정 저장" : "저장"}</button>
    </div>`;
  renderCoord(); renderThumbs();
  $(".sv-body", panel).scrollTop = 0;
}
function renderCoord() {
  const box = $("#svCoord"); if (!box || !draft) return;
  box.classList.remove("warn");
  if (draft.kind === "road") {
    const n = draft.pts.length;
    let len = 0; for (let i = 1; i < n; i++) len += map.distance([draft.pts[i - 1].lat, draft.pts[i - 1].lng], [draft.pts[i].lat, draft.pts[i].lng]);
    box.innerHTML = n ? `점 ${n}개 · 길이 약 ${Math.round(len)}m${n < 2 ? " · 점을 하나 더 찍어 주세요" : ""}` : "아직 점이 없습니다";
    return;
  }
  const l = draft.loc;
  if (!l) { box.textContent = "위치를 아직 정하지 않았습니다"; return; }
  const src = l.src === "gps" ? `GPS${l.acc ? ` ±${l.acc}m` : ""}` : "지도에서 찍음";
  const out = !bounds.contains([l.lat, l.lng]);
  box.innerHTML = `<span class="ll">${l.lat.toFixed(6)}, ${l.lng.toFixed(6)}</span> · ${src}
    <button type="button" class="sv-link" data-act="copy">복사</button>
    ${l.acc > GPS_WARN_M ? `<br>정확도가 낮습니다. 핀 위치를 확인하고 필요하면 끌어서 옮겨 주세요.` : ""}
    ${out ? `<br>조사 범위(점선 사각형) 밖입니다.` : ""}`;
  box.classList.toggle("warn", l.acc > GPS_WARN_M || out);
}

paneNew.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.cat) return startDraft(b.dataset.cat);
  if (b.dataset.ph) {
    const i = Number(b.dataset.i);
    if (b.dataset.ph === "first") draft.photos.unshift(...draft.photos.splice(i, 1));
    else { const [p] = draft.photos.splice(i, 1); if (!p.fresh) draft.removed.push(p.id); }
    return renderThumbs();
  }
  switch (b.dataset.act) {
    case "change": return startDraft(null);
    case "gps": return startGps();
    case "undo": draft.pts.pop(); return drawLine();
    case "clearpts": draft.pts = []; return drawLine();
    case "copy": {
      const t = `${draft.loc.lat}, ${draft.loc.lng}`;
      try { await navigator.clipboard.writeText(t); toast("좌표를 복사했습니다: " + t); }
      catch { prompt("아래 좌표를 길게 눌러 복사하세요", t); }
      return;
    }
    case "cancel": return startDraft(null);
    case "delete": return deleteRecord(draft.editing);
    case "save": return saveDraft();
  }
});
paneNew.addEventListener("change", e => {
  if (e.target.type === "file" && e.target.files.length) { addPhotos([...e.target.files]); e.target.value = ""; }
});

async function saveDraft() {
  let data;
  try { data = readFields($("#svForm")); } catch (err) { return toast(err.message); }
  const d = draft, road = d.kind === "road";
  if (road ? d.pts.length < 2 : !d.loc) return toast(road ? "지도에서 선의 점을 2개 이상 찍어 주세요." : "위치를 정해 주세요. (현재 위치 버튼 또는 지도 누르기)");
  if (!surveyor()) return askName(true);
  const now = new Date().toISOString(), old = d.editing;
  const rec = {
    id: old?.id || newId(), kind: d.kind, category: d.cat,
    surveyor: old?.surveyor || surveyor(), surveyDate: old?.surveyDate || dateInput.value || today(),
    createdAt: old?.createdAt || now, updatedAt: now, exportedAt: old?.exportedAt || null,
    data, memo: $("#svMemo").value.trim() || null, photoIds: d.photos.map(p => p.id),
  };
  if (road) {
    rec.coords = d.pts.map(p => [p.lng, p.lat]);
    rec.pointSources = d.pts.map(p => p.src);
    rec.coordSource = d.pts.every(p => p.src === "gps") ? "gps" : "map";
  } else Object.assign(rec, { lat: d.loc.lat, lng: d.loc.lng, coordSource: d.loc.src, gpsAccuracy: d.loc.acc });
  try {
    for (const p of d.photos.filter(p => p.fresh))
      await DB.put("photos", { id: p.id, recordId: rec.id, type: p.blob.type, data: await p.blob.arrayBuffer() });
    for (const id of d.removed) await DB.del("photos", id);
    await DB.put("records", rec);
  } catch (err) {
    console.error(err);
    return toast("저장하지 못했습니다. 개인정보 보호(비공개) 모드가 아닌지, 저장 공간이 남아 있는지 확인해 주세요.", 7000);
  }
  toast(old ? "수정했습니다." : `저장했습니다. 같은 분류를 이어서 입력할 수 있습니다.`);
  await refreshSaved();
  startDraft(old ? null : d.cat);
}
async function deleteRecord(rec) {
  if (!confirm("이 기록을 삭제할까요? 되돌릴 수 없습니다.")) return;
  for (const p of await DB.photosOf(rec.id)) await DB.del("photos", p.id);
  await DB.del("records", rec.id);
  toast("삭제했습니다."); await refreshSaved(); startDraft(null);
  if (tab === "list") renderList();
}

// ── 저장된 기록: 지도 표시 · 목록 ──────────────────
let records = [];
async function refreshSaved() {
  try { records = await DB.all("records"); } catch (err) { console.error(err); records = []; toast("이 브라우저에서는 기기 저장소를 쓸 수 없습니다. 개인정보 보호(비공개) 모드를 꺼 주세요.", 8000); }
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  savedLayer.clearLayers();
  records.forEach(r => {
    const layer = r.kind === "road"
      ? L.polyline(r.coords.map(([lng, lat]) => [lat, lng]), { color: SCATS.road.color, weight: 6, dashArray: "2 8", opacity: .9, bubblingMouseEvents: false })
      : L.marker([r.lat, r.lng], { icon: pinIconOf(r.category, "survey"), title: `조사 기록 · ${SCATS[r.category].label}` });
    layer.on("click", ev => { L.DomEvent.stopPropagation(ev); openRecord(r.id); }).addTo(savedLayer);
  });
  const pending = records.filter(isPending).length;
  $("#svCount").textContent = records.length ? `${records.length}${pending ? `·새 ${pending}` : ""}` : "";
}
const isPending = r => !r.exportedAt || r.updatedAt > r.exportedAt;
function openRecord(id) {
  const r = records.find(x => x.id === id); if (!r) return;
  showTab("new"); startDraft(r.category, r);
  map.panTo(r.kind === "road" ? [r.coords[0][1], r.coords[0][0]] : [r.lat, r.lng]);
}
function summary(r) {
  const d = r.data || {};
  const bits = [d.name, d.location, d.count != null && r.kind !== "road" ? `${d.count}개` : null, d.steps != null ? `${d.steps}칸` : null];
  if (r.kind === "road") bits.unshift({ sidewalk:"인도", roadway:"차도", shared:"보차혼용" }[d.type]);
  return bits.filter(Boolean).join(" · ") || "(설명 없음)";
}
let listAll = false;
function renderList() {
  const shown = listAll ? records : records.filter(r => r.surveyDate === dateInput.value);
  const groups = shown.reduce((g, r) => ((g[r.surveyDate] ||= []).push(r), g), {});
  paneList.innerHTML = `
    <div class="seg sv-listmode"><button type="button" data-all="0" class="${listAll ? "" : "on"}">조사일 ${esc(dateInput.value)}</button>
      <button type="button" data-all="1" class="${listAll ? "on" : ""}">전체 ${records.length}개</button></div>
    ${shown.length ? Object.keys(groups).sort().reverse().map(day => `<h4 class="sv-sub">${esc(day)} · ${groups[day].length}개</h4>
      <ul class="sv-list">${groups[day].map(r => `<li><button type="button" data-open="${r.id}" style="--c:${SCATS[r.category].color}">
        <span class="dot"></span><span class="t"><b>${esc(SCATS[r.category].label)}</b> ${esc(summary(r))}
        <small>${esc(r.surveyor)}${r.photoIds?.length ? ` · 사진 ${r.photoIds.length}` : ""}${isPending(r) ? "" : " · 내보냄"}</small></span></button></li>`).join("")}</ul>`).join("")
      : `<p class="note">${listAll ? "아직 저장한 기록이 없습니다." : "이 조사일에 저장한 기록이 없습니다. ‘전체’를 눌러 다른 날짜 기록을 볼 수 있습니다."}</p>`}
    <p class="note">지도에 노란 점선 테두리 핀(선은 점선)으로 보이는 것이 이 기기에 저장된 조사 기록입니다. 눌러서 수정·삭제할 수 있습니다.</p>`;
}
paneList.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.all) { listAll = b.dataset.all === "1"; renderList(); }
  if (b.dataset.open) openRecord(b.dataset.open);
});

// ── 내보내기 ─────────────────────────────────────
let lastZip = null;
function renderExport() {
  const pending = records.filter(isPending).length, done = records.length - pending;
  const canShare = !!(navigator.canShare && window.File);
  paneExport.innerHTML = `
    <p>이 기기에 저장된 기록 <b>${records.length}개</b>${records.length ? ` (아직 내보내지 않은 것 ${pending}개)` : ""}</p>
    <button type="button" class="btn big" data-act="zip" ${records.length ? "" : "disabled"}>zip 파일 만들기 (전체 ${records.length}개)</button>
    <div id="svZipOut"></div>
    <p class="note">zip 안에는 기록(survey.json), 엑셀 확인용 표(survey.csv), 사진(photos/)이 들어 있습니다.
      팀원들의 zip을 모아 Claude Code에 올리면 검토 후 지도에 합칩니다. 합치기 전까지 공개 지도에는 나오지 않습니다.</p>
    ${canShare ? "" : `<p class="note">이 브라우저는 바로 공유를 지원하지 않아 파일로만 저장됩니다.</p>`}
    <hr>
    <button type="button" class="btn2 danger" data-act="purge" ${done ? "" : "disabled"}>내보낸 기록 지우기 (${done}개)</button>
    <p class="note">내보낸 뒤 수정하지 않은 기록만 지웁니다. zip을 잘 전달한 것을 확인한 뒤에 누르세요.</p>`;
  if (lastZip) showZipButtons();
}
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = JSZIP_URL;
    s.onload = () => res(window.JSZip); s.onerror = () => rej(new Error("zip 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요."));
    document.head.appendChild(s);
  });
}
// 파일 이름용 로마자 표기(일부 브라우저가 한글 파일 이름을 ‘download’로 바꿔 버림). 예: 홍길동 → honggildong
const RR_I = "g kk n d tt r m b pp s ss _ j jj ch k t p h".split(" ");
const RR_V = "a ae ya yae eo e yeo ye o wa wae oe yo u wo we wi yu eu ui i".split(" ");
const RR_F = "_ k k k n n n t l k m l l l p l m p p t t ng t t k t p t".split(" ");
function romanize(str) {
  const out = [...str].map(ch => {
    const c = ch.charCodeAt(0) - 0xAC00;
    if (c < 0 || c > 11171) return ch;
    return [RR_I[Math.floor(c / 588)], RR_V[Math.floor(c % 588 / 28)], RR_F[c % 28]].join("").replace(/_/g, "");
  }).join("");
  return out.replace(/[^A-Za-z0-9-]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "surveyor";
}
const csvCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
function fmt([type, key, label, extra], data) {
  const v = key.split(".").reduce((o, p) => o?.[p], data);
  if (type === "tri") return (extra || TRI)[v === true ? 0 : v === false ? 1 : 2];
  if (type === "hours") return hoursText(v ?? null);
  if (type === "choice") return v == null ? "모름" : (optsOf(extra).find(([x]) => x === v)?.[1] ?? v);
  return v ?? (type === "text" ? "" : "모름");
}
function detailText(r) {
  let head = "";
  return FIELDS[r.category].map(f => {
    if (f[0] === "head") { head = f[1] + " "; return null; }
    const v = fmt(f, r.data || {});
    return v === "" ? null : `${f[0] === "tri" && head ? head : ""}${f[2]}: ${v}`;
  }).filter(Boolean).join(" / ");
}
async function buildZip() {
  const btn = $('[data-act="zip"]', paneExport); btn.disabled = true; btn.textContent = "만드는 중…";
  try {
    const JSZip = await loadJSZip(), zip = new JSZip(), name = surveyor() || "조사자";
    const exportedAt = new Date().toISOString(), out = [];
    const rows = [["기록ID","분류","조사일","조사자","위도","경도","좌표 출처","GPS 정확도(m)","내용","메모","사진 수"]];
    for (const r of records) {
      const photos = await DB.photosOf(r.id), order = r.photoIds || [];
      photos.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const files = photos.map((p, i) => { const f = `photos/${r.id}-${i + 1}.jpg`; zip.file(f, p.data); return f; });
      const { photoIds, ...rest } = r;
      out.push({ ...rest, photos: files });
      const [lat, lng] = r.kind === "road" ? [r.coords[0][1], r.coords[0][0]] : [r.lat, r.lng];
      rows.push([r.id, SCATS[r.category].label, r.surveyDate, r.surveyor, lat, lng,
        r.coordSource === "gps" ? "GPS" : "지도", r.gpsAccuracy ?? "", detailText(r), r.memo ?? "", files.length]);
    }
    zip.file("survey.json", JSON.stringify({ format: "walkmap-survey", version: 1, exportedAt, exportedBy: name, records: out }, null, 2));
    zip.file("survey.csv", "﻿" + rows.map(row => row.map(csvCell).join(",")).join("\r\n"));
    const blob = await zip.generateAsync({ type: "blob", mimeType: "application/zip" });
    lastZip = { blob, name: `survey-${today().replace(/-/g, "")}-${romanize(name)}.zip` };
    for (const r of records) await DB.put("records", { ...r, exportedAt });
    await refreshSaved(); renderExport();
    toast("zip 파일을 만들었습니다. 저장하거나 공유해 주세요.");
  } catch (err) {
    console.error(err); toast(err.message || "zip 파일을 만들지 못했습니다.", 6000);
    btn.disabled = false; btn.textContent = "zip 파일 만들기";
  }
}
function showZipButtons() {
  const file = window.File && new File([lastZip.blob], lastZip.name, { type: "application/zip" });
  const share = file && navigator.canShare?.({ files: [file] });
  $("#svZipOut").innerHTML = `<div class="sv-zip"><b>${esc(lastZip.name)}</b> (${Math.ceil(lastZip.blob.size / 1024)}KB)
    <div class="sv-row"><button type="button" class="btn" data-act="download">💾 파일로 저장</button>
    ${share ? `<button type="button" class="btn2" data-act="share">📤 공유 (카톡·AirDrop 등)</button>` : ""}</div></div>`;
}
paneExport.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  switch (b.dataset.act) {
    case "zip": return buildZip();
    case "download": {
      const a = document.createElement("a"); a.href = URL.createObjectURL(lastZip.blob); a.download = lastZip.name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      return toast("저장했습니다. 아이패드는 ‘파일’ 앱 > 다운로드 폴더에서 찾을 수 있습니다.", 6000);
    }
    case "share":
      try { await navigator.share({ files: [new File([lastZip.blob], lastZip.name, { type: "application/zip" })], title: lastZip.name }); }
      catch (err) { if (err.name !== "AbortError") toast("공유하지 못했습니다. ‘파일로 저장’을 써 주세요."); }
      return;
    case "purge": {
      const done = records.filter(r => !isPending(r));
      if (!confirm(`내보낸 뒤 수정하지 않은 기록 ${done.length}개를 이 기기에서 지울까요?\nzip 파일을 전달했는지 먼저 확인해 주세요.`)) return;
      for (const r of done) { for (const p of await DB.photosOf(r.id)) await DB.del("photos", p.id); await DB.del("records", r.id); }
      lastZip = null; await refreshSaved(); renderExport(); toast(`${done.length}개를 지웠습니다.`);
    }
  }
});

// ── 시작 ─────────────────────────────────────────
startDraft(null);
refreshSaved();
layout();
})();
