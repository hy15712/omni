// 보행 구간 데이터 (GeoJSON, 좌표 순서 [경도, 위도]) — 샘플
// type: "sidewalk"(인도) | "roadway"(차도) | "shared"(보차혼용)
// 주관적 평가("안전함/위험함") 대신 측정 가능한 속성만 기록합니다.
window.ROADS = { type:"FeatureCollection", features:[
  { type:"Feature", properties:{ id:"seg-001", name:"[샘플] 종로 북측 보도", type:"sidewalk",
      widthM:4.0, surface:"보도블록", curbCut:true, slopeNote:"경사 측정 전",
      verification:{ status:"field", date:"2026-09-21" } },
    geometry:{ type:"LineString", coordinates:[[126.9830,37.57065],[126.9921,37.57085]] } },
  { type:"Feature", properties:{ id:"seg-002", name:"[샘플] 종로 차도", type:"roadway",
      widthM:null, surface:"아스팔트", curbCut:null, slopeNote:null,
      verification:{ status:"agency", date:"2026-06-01" } },
    geometry:{ type:"LineString", coordinates:[[126.9830,37.57035],[126.9921,37.57055]] } },
  { type:"Feature", properties:{ id:"seg-003", name:"[샘플] 골목길", type:"shared",
      widthM:2.5, surface:"아스팔트", curbCut:null, slopeNote:"완만한 오르막(북쪽 방향)",
      verification:{ status:"unverified", date:"2026-05-11" } },
    geometry:{ type:"LineString", coordinates:[[126.9896,37.5731],[126.9898,37.5717]] } },
]};
