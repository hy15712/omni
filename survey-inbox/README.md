# survey-inbox

조사 입력 모드에서 내보낸 zip을 **풀어서** 이 폴더에 넣습니다(zip 하나당 폴더 하나).
그다음 `node scripts/merge-survey.mjs` → `검토.md` 확인 → `decisions.json` 수정 → `node scripts/merge-survey.mjs --apply`.

이 폴더의 내용(조사자 이름 포함)은 `.gitignore`로 저장소에 올라가지 않습니다. 이 설명 파일만 올라갑니다.
