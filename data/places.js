// ───────────────────────────────────────────────
// 시설 데이터 (2026-11-01 샘플 삭제, 조사 기록을 합치면 여기에 들어옴)
// verification.status: "field"(현장확인) | "agency"(기관확인) | "unverified"(확인불가)
// hours: "24h" | null(확인불가) | { mon:[["09:00","18:00"]], ..., sun:[] }  (빈 배열 = 휴무)
// coordSource: 좌표 출처 — "gps"(현장 GPS) | "map"(우리 지도에서 찍음) | "public"(공공데이터) | "osm"
// details.photos: 위치 사진 경로 목록(첫 장이 대표). 조사 입력 모드 → scripts/merge-survey.mjs 로 들어옴
// ───────────────────────────────────────────────
window.PLACES = [
];
