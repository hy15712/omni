// ───────────────────────────────────────────────
// 시설 데이터 (모두 형식 확인용 샘플 — 실제 정보 아님)
// verification.status: "field"(현장확인) | "agency"(기관확인) | "unverified"(확인불가)
// hours: "24h" | null(확인불가) | { mon:[["09:00","18:00"]], ..., sun:[] }  (빈 배열 = 휴무)
// coordSource: 좌표 출처 — "gps"(현장 GPS) | "public"(공공데이터) | "osm"
// ───────────────────────────────────────────────
const WEEKDAY_9_18 = { mon:[["09:00","18:00"]], tue:[["09:00","18:00"]], wed:[["09:00","18:00"]],
  thu:[["09:00","18:00"]], fri:[["09:00","18:00"]], sat:[], sun:[] };

window.PLACES = [
  { id:"toilet-001", category:"toilet", name:"[샘플] 공원 내 공중화장실", lat:37.5716, lng:126.9881,
    details:{ location:"공원 동문 안쪽 왼편", accessibleStall:true, open:true,
      approach:{ step:false, stairs:false, ramp:true } },
    hours:{ mon:[["08:00","22:00"]], tue:[["08:00","22:00"]], wed:[["08:00","22:00"]], thu:[["08:00","22:00"]],
      fri:[["08:00","22:00"]], sat:[["08:00","22:00"]], sun:[["08:00","22:00"]] },
    verification:{ status:"field", date:"2026-09-21", by:"조사팀" }, coordSource:"gps", sample:true },

  { id:"bench-001", category:"bench", name:"[샘플] 벤치", lat:37.5720, lng:126.9876,
    details:{ count:2, location:"공원 서쪽 산책로" }, hours:"24h",
    verification:{ status:"field", date:"2026-09-21", by:"조사팀" }, coordSource:"gps", sample:true },

  { id:"stairs-001", category:"stairs", name:"[샘플] 역 출입구 계단", lat:37.5708, lng:126.9912,
    details:{ steps:24, location:"출입구에서 지하 대합실까지", handrail:"양쪽", altRoute:"인근 엘리베이터 있음" },
    hours:null, verification:{ status:"field", date:"2026-09-21", by:"조사팀" }, coordSource:"gps", sample:true },

  { id:"aed-001", category:"aed", name:"[샘플] AED", lat:37.5700, lng:126.9868,
    details:{ location:"건물 1층 로비 안내데스크 옆", photo:null }, hours:WEEKDAY_9_18,
    verification:{ status:"agency", date:"2026-09-01", by:"공공데이터(AED 표준데이터)" }, coordSource:"public", sample:true },

  { id:"pharm-001", category:"pharmacy", name:"[샘플] 약국", lat:37.5691, lng:126.9893,
    details:{ phone:"02-000-0000" },
    hours:{ mon:[["09:00","21:00"]], tue:[["09:00","21:00"]], wed:[["09:00","21:00"]], thu:[["09:00","21:00"]],
      fri:[["09:00","21:00"]], sat:[["10:00","15:00"]], sun:[] },
    verification:{ status:"agency", date:"2026-09-30", by:"공공데이터(약국 정보)" }, coordSource:"public", sample:true },

  { id:"hosp-001", category:"hospital", name:"[샘플] 의원", lat:37.5684, lng:126.9906,
    details:{ phone:"02-000-0000", dept:"내과" }, hours:WEEKDAY_9_18,
    verification:{ status:"agency", date:"2026-09-30", by:"공공데이터(병의원 정보)" }, coordSource:"public", sample:true },

  { id:"fire-001", category:"fire", name:"[샘플] 119안전센터", lat:37.5675, lng:126.9850,
    details:{}, hours:"24h",
    verification:{ status:"unverified", date:"2026-08-10", by:"" }, coordSource:"public", sample:true },

  { id:"police-001", category:"police", name:"[샘플] 지구대", lat:37.5696, lng:126.9860,
    details:{}, hours:"24h",
    verification:{ status:"agency", date:"2026-09-15", by:"공공데이터(지구대·파출소 현황)" }, coordSource:"public", sample:true },

  { id:"trash-001", category:"trash", name:"[샘플] 쓰레기통", lat:37.5712, lng:126.9890,
    details:{ location:"공원 정문 옆", recycling:null }, hours:null,
    verification:{ status:"unverified", date:"2026-07-02", by:"" }, coordSource:"public", sample:true },
];
